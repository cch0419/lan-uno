export function websocketUrl(origin) {
  const url = new URL('/ws', origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

export function invitation(config, currentOrigin) {
  if (config?.mode === 'internet') {
    const pending = config.tunnelStatus === 'starting';
    const unavailable = ['stopped', 'failed'].includes(config.tunnelStatus);
    return { address: pending || unavailable ? '' : config.publicUrl ?? '',
      canCopy: !!config.publicUrl && !pending && !unavailable,
      hint: pending ? '正在连接公网入口，请稍候…局域网仍可使用。' : unavailable
        ? '公网入口已关闭。局域网仍可玩；重新启动公网模式后再分享新链接。'
        : '朋友可用不同 WiFi 或移动数据打开此网址，再输入房间号。电脑和公网启动窗口需保持运行。' };
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(currentOrigin).hostname);
  return { address: currentOrigin, canCopy: !local,
    hint: local ? '你正在使用本机地址。其他设备请使用终端显示的局域网网址；跨网络请使用公网启动模式。'
      : '朋友需要与你处于可互通的局域网；跨网络请由主机开启公网模式。' };
}
