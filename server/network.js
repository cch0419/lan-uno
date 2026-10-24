/** Explicit public origin configuration. Forwarded headers are never trusted. */
export function parsePublicUrl(value = '') {
  if (value === '') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
        url.search || url.hash || !url.hostname.includes('.') || /[\s*?#]/.test(value) ||
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost')) throw new Error();
    return url.origin;
  } catch {
    throw new Error('UNO_PUBLIC_URL 必须是完整的公网 HTTPS 网址，不含账号、路径、查询参数或通配符');
  }
}

export function parseAuthority(value) {
  if (typeof value !== 'string' || !value || /[\s/@\\?#,*]/.test(value)) return null;
  try {
    const url = new URL(`http://${value}`);
    return { hostname: url.hostname.toLowerCase(), host: url.host.toLowerCase() };
  } catch { return null; }
}

const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

export function createNetworkPolicy({ localHosts, extraHosts = '', publicUrl = '', tunnelStatus } = {}) {
  const local = new Set(localHosts.map(host => host.toLowerCase()));
  const extra = new Set();
  for (const host of extraHosts.split(',').map(s => s.trim()).filter(Boolean)) {
    const parsed = parseAuthority(host);
    if (!parsed || parsed.host !== parsed.hostname) throw new Error('UNO_ALLOWED_HOSTS 只能填写逗号分隔的主机名或 IP，不含端口和通配符');
    extra.add(parsed.hostname);
  }
  let origin = parsePublicUrl(publicUrl);
  let status = tunnelStatus ?? (origin ? 'configured' : 'off');
  const validHost = request => {
    const host = parseAuthority(request.headers.host);
    if (!host) return false;
    if (origin && host.hostname === new URL(origin).hostname) return host.host === new URL(origin).host;
    return local.has(host.hostname) || extra.has(host.hostname);
  };
  return {
    validHost,
    validOrigin(request) {
      if (!validHost(request)) return false;
      const host = parseAuthority(request.headers.host);
      const raw = request.headers.origin;
      const publicHost = origin && host.hostname === new URL(origin).hostname;
      // Nonbrowser local tools remain usable. A public browser endpoint needs
      // an exact Origin and cannot downgrade the configured HTTPS origin.
      if (!raw) return !publicHost;
      try {
        const url = new URL(raw);
        if (!['http:', 'https:'].includes(url.protocol) || raw !== url.origin) return false;
        if (publicHost) return raw === origin;
        if (raw === origin && loopback(request.socket.remoteAddress) &&
            ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) return true;
        return url.host.toLowerCase() === host.host;
      } catch { return false; }
    },
    configurePublicUrl(value, nextStatus = 'ready') {
      origin = parsePublicUrl(value);
      status = nextStatus;
    },
    setTunnelStatus(value) { status = value; },
    clientConfig() {
      return { mode: status === 'off' ? 'lan' : 'internet', publicUrl: origin,
        tunnelStatus: status };
    }
  };
}
