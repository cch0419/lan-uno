import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager, send } from './rooms.js';
import { openBrowser } from './open-browser.js';

export function localAddresses() {
  return Object.values(networkInterfaces()).flat().filter(item =>
    item.family === 'IPv4' && !item.internal
  ).map(item => item.address);
}

export async function createServer(options = {}) {
  const manager = new RoomManager(options);
  const files = new Map();
  for (const [route, file, mime] of [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
    ['/game.css', 'game.css', 'text/css; charset=utf-8'],
    ['/table-layout.js', 'table-layout.js', 'text/javascript; charset=utf-8'],
    ['/hand-layout.js', 'hand-layout.js', 'text/javascript; charset=utf-8'],
    ['/effects.js', 'effects.js', 'text/javascript; charset=utf-8'],
    ['/sounds.js', 'sounds.js', 'text/javascript; charset=utf-8'],
    ['/audio/uno.wav', 'audio/uno.wav', 'audio/wav'],
    ['/audio/victory.wav', 'audio/victory.wav', 'audio/wav']
  ]) {
    files.set(route, { body: await readFile(new URL(`../public/${file}`, import.meta.url)), mime });
  }
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', hostname().toLowerCase(),
    ...localAddresses(), ...(process.env.UNO_ALLOWED_HOSTS ?? '').split(',').filter(Boolean)]);
  const validHost = request => {
    try { return allowedHosts.has(new URL(`http://${request.headers.host}`).hostname.toLowerCase()); }
    catch { return false; }
  };
  const server = http.createServer((request, response) => {
    if (!validHost(request)) { response.writeHead(403); response.end('Host not allowed'); return; }
    let path;
    try { path = new URL(request.url, 'http://localhost').pathname; }
    catch { response.writeHead(400); response.end(); return; }
    const file = files.get(path);
    if (!file || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404); response.end('Not found'); return;
    }
    response.writeHead(200, {
      'Content-Type': file.mime, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    });
    response.end(request.method === 'HEAD' ? undefined : file.body);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    let validOrigin = !request.headers.origin;
    try {
      if (request.headers.origin) {
        const origin = new URL(request.headers.origin);
        validOrigin = ['http:', 'https:'].includes(origin.protocol) && origin.host === request.headers.host;
      }
    } catch { validOrigin = false; }
    if (!validHost(request) || !validOrigin || request.url !== '/ws' || wss.clients.size >= 200) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', socket => {
    socket.isAlive = true;
    socket.connectedAt = Date.now();
    const rateBurst = options.rateBurst ?? 40;
    let tokens = rateBurst;
    let lastMessage = Date.now();
    socket.on('error', () => {});
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', (raw, binary) => {
      const now = Date.now();
      tokens = Math.min(rateBurst, tokens + (now - lastMessage) / 50);
      lastMessage = now;
      if (tokens < 1) { socket.close(1008, 'Too many messages'); return; }
      tokens--;
      if (binary) { socket.close(1003, 'Text JSON only'); return; }
      try { manager.handle(socket, JSON.parse(raw.toString())); }
      catch { send(socket, 'COMMAND_RESULT', { ok: false, code: 'INVALID_JSON', message: '消息不是有效 JSON' }); }
    });
    socket.on('close', () => manager.disconnect(socket));
  });
  const cleanup = setInterval(() => {
    manager.sweep();
    for (const socket of wss.clients) {
      if (!socket.playerId && Date.now() - socket.connectedAt > 10_000) socket.terminate();
    }
  }, 1000);
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) { socket.terminate(); continue; }
      socket.isAlive = false; socket.ping();
    }
  }, 15_000);
  cleanup.unref(); heartbeat.unref();
  return {
    server, manager, wss,
    async close() {
      clearInterval(cleanup); clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
  const app = await createServer();
  app.server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`启动失败：端口 ${port} 已被占用。若游戏已在运行，请先在原服务窗口按 Ctrl+C，再重新启动。`);
      console.error(`也可以用另一个端口启动；当前配置的管理地址为 http://localhost:${port}/`);
    } else console.error('启动失败：', error.message);
    process.exitCode = 1;
  });
  app.server.listen(port, '0.0.0.0', () => {
    const managementUrl = `http://localhost:${port}/`;
    console.log(`\nUNO · 局域网牌桌\n本机管理：${managementUrl}`);
    for (const address of localAddresses()) console.log(`局域网：http://${address}:${port}`);
    console.log('同局域网朋友打开以上地址即可。Ctrl+C 停止服务。\n');
    // Open only after listening succeeds; tests and unattended deployments can
    // opt out. A missing default browser must never stop the game service.
    if (process.env.UNO_OPEN_BROWSER !== '0' && !process.argv.includes('--no-open')) {
      openBrowser(managementUrl).then(opened => {
        if (!opened) console.warn(`无法自动打开浏览器，请手动访问：${managementUrl}`);
      });
    }
  });
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
