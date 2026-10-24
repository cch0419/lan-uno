import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createServer, localAddresses } from '../server/index.js';
import { openBrowser } from '../server/open-browser.js';
import { watchTunnel } from '../server/tunnel.js';

const run = promisify(execFile);
const downloads = 'https://developers.cloudflare.com/tunnel/downloads/';

export async function findCloudflared() {
  const portable = fileURLToPath(new URL(`../tools/cloudflared${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
  const candidates = process.env.CLOUDFLARED_PATH ? [process.env.CLOUDFLARED_PATH] : [portable, 'cloudflared'];
  for (const candidate of candidates) {
    try {
      await run(candidate, ['--version'], { timeout: 10_000, windowsHide: true });
      return candidate;
    } catch { /* Try the next explicitly supported location. Never install silently. */ }
  }
  throw new Error(`未找到可运行的 cloudflared。\n请从官方下载安装：${downloads}\nWindows 可将官方可执行文件重命名为 cloudflared.exe，放到本项目 tools 文件夹，或安装到 PATH。\n也可用 CLOUDFLARED_PATH 指定完整路径。局域网模式仍可使用 npm start。`);
}

export async function startInternet() {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1～65535 的整数');
  const binary = await findCloudflared();
  // Quick Tunnel owns its random hostname; discard any stale public URL from
  // a previous terminal session. No restart is required after discovery.
  const app = await createServer({ publicUrl: '', tunnelStatus: 'starting' });
  try {
    app.server.listen(port, '0.0.0.0');
    await once(app.server, 'listening');
  } catch (error) {
    await app.close();
    throw new Error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请先停止原 UNO 服务再运行公网模式。` : error.message);
  }
  const managementUrl = `http://localhost:${port}/`;
  console.log(`\nUNO · 电脑作为服务器\n本机管理：${managementUrl}`);
  for (const address of localAddresses()) console.log(`局域网：http://${address}:${port}`);
  console.log('正在建立公网入口…成功后大厅会自动显示邀请网址。Ctrl+C 停止本次服务和隧道。');
  app.server.on('error', error => console.error('服务错误：', error.message));
  const child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  const tunnel = watchTunnel(child, app.network);
  const startupNotice = setTimeout(() => {
    if (app.network.clientConfig().tunnelStatus === 'starting') {
      console.warn('公网连接仍未就绪，请检查终端错误、网络能否连接 Cloudflare，以及 .cloudflared 下是否存在影响 Quick Tunnel 的配置文件。局域网服务仍可使用。');
    }
  }, 60_000);
  startupNotice.unref();
  if (process.env.UNO_OPEN_BROWSER !== '0' && !process.argv.includes('--no-open')) {
    openBrowser(managementUrl).then(opened => {
      if (!opened) console.warn(`请手动打开管理页：${managementUrl}`);
    });
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(startupNotice);
    tunnel.stop();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await app.close();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return { app, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startInternet().catch(error => { console.error(`\n公网启动失败：${error.message}`); process.exitCode = 1; });
}
