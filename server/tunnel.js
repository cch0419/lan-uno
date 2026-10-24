/** Parse only the generated HTTPS hostname, never arbitrary log URLs. */
export function quickTunnelUrl(line) {
  return line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=[\s/]|$)/i)?.[0].toLowerCase() ?? null;
}

/** Update live invitation metadata without restarting or clearing rooms. */
export function watchTunnel(child, network, { log = console.log, warn = console.warn } = {}) {
  let publicUrl = null;
  let registered = false;
  let announcedUrl = null;
  let closed = false;
  let intentional = false;
  let invalidated = false;
  const buffers = { stdout: '', stderr: '' };
  network.setTunnelStatus('starting');
  const line = value => {
    if (invalidated || intentional) return;
    if (/Unauthorized:\s*Tunnel not found|Invalid tunnel secret|Record for tunnel not found/i.test(value)) {
      invalidated = true;
      registered = false;
      network.configurePublicUrl('', 'failed');
      warn('公网临时隧道标识已失效（Tunnel not found），旧邀请网址不可再用。请重新运行公网模式取得新网址；局域网服务继续运行。');
      child.kill(); // Stop only this owned, invalid tunnel rather than retry forever.
      return;
    }
    const found = quickTunnelUrl(value);
    if (found && found !== publicUrl) {
      publicUrl = found;
      network.configurePublicUrl(found, registered ? 'ready' : 'starting');
    }
    if (/Registered tunnel connection/i.test(value)) registered = true;
    if (registered && publicUrl) {
      if (network.clientConfig().tunnelStatus !== 'ready') network.configurePublicUrl(publicUrl, 'ready');
      if (announcedUrl !== publicUrl) {
        announcedUrl = publicUrl;
        log(`\n公网邀请：${publicUrl}\n朋友打开此网址，再输入房间号即可。电脑和本窗口需保持运行。\n`);
      }
    }
    if (/\b(ERR|error)\b/i.test(value) && !intentional) warn(`[公网隧道] ${value.slice(0, 600)}`);
  };
  const consume = (key, chunk) => {
    buffers[key] += chunk.toString();
    const lines = buffers[key].split(/\r?\n/);
    buffers[key] = lines.pop().slice(-8192);
    lines.forEach(line);
  };
  child.stdout?.on('data', chunk => consume('stdout', chunk));
  child.stderr?.on('data', chunk => consume('stderr', chunk));
  const finish = error => {
    if (closed) return;
    closed = true;
    Object.values(buffers).filter(Boolean).forEach(line);
    network.setTunnelStatus(intentional ? 'stopped' : 'failed');
    if (!intentional) warn(`公网入口已停止${error ? `：${error.message}` : ''}。局域网服务继续运行。检查网络后重新运行公网启动命令。`);
  };
  child.on('error', finish);
  child.on('close', () => finish());
  return {
    stop() {
      intentional = true;
      network.setTunnelStatus('stopped');
      if (!closed) child.kill(); // Only the child created by this launcher.
    }
  };
}
