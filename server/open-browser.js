import { execFile } from 'node:child_process';

/** Launch the OS default browser without keeping a helper console open. */
export function browserCommand(url, platform = process.platform) {
  const address = new URL(url);
  if (!['http:', 'https:'].includes(address.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) {
    throw new Error('Only a local management URL may be opened automatically');
  }
  if (platform === 'win32') {
    // Pass one safely quoted literal to PowerShell; no cmd /c start quoting.
    const literal = address.href.replaceAll("'", "''");
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Start-Process -FilePath '${literal}'`]];
  }
  return platform === 'darwin' ? ['open', [address.href]] : ['xdg-open', [address.href]];
}

export function openBrowser(url, { platform = process.platform, run = execFile } = {}) {
  const [file, args] = browserCommand(url, platform);
  return new Promise(resolve => {
    // Hides only the Windows helper console; the requested browser is visible.
    run(file, args, { windowsHide: true, timeout: 10_000 }, error => resolve(!error));
  });
}
