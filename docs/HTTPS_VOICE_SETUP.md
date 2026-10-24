# HTTPS 与麦克风

语音模块从同事 PR #1 合入。浏览器麦克风需要安全上下文和用户授权；普通 `http://192.168...` 手机地址不满足此条件。参考 [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)。

## 推荐：现有公网 HTTPS 邀请链接

继续使用 `npm run start:internet` 或 `start-internet.bat`，手机访问终端生成的 HTTPS 链接。玩家点击“开启听筒”后才能稳定播放收到的语音；“按住说话”才申请录音，松手、切后台、失焦或断线会停麦。单次最多 15 秒。

## 仅局域网：可选本机 HTTPS

运行 `start-https.bat`。脚本需要 Node 24、Git for Windows 中的 OpenSSL（或系统 OpenSSL），将证书生成到 `.certs/`。默认端口 3443，允许该端口后访问 `https://电脑内网IP:3443`。

脚本不会自动修改系统信任设置。需要你在自己的每台设备安装并信任 `.certs/lan-uno-ca.crt`（也可从 `/voice-ca.crt` 下载公钥证书）；具体入口按设备系统的证书安装设置操作。只分享 `.crt`，不要分享 `.key`。浏览器证书错误未解决前不保证能录音，不要把点过警告当作已信任。IP 变化后重新启动可重新生成服务器证书。

## 云服务器 HTTPS

使用 [Docker/云部署教程](PUBLIC_DEPLOYMENT_GUIDE.md) 的真实域名与可信 HTTPS 入口。示例域名需要替换，文档不绑定任何同事的服务器。

## 转文字兼容性

“按住转文字”使用浏览器 SpeechRecognition / webkitSpeechRecognition，最长约 13 秒，松手后显示头顶漫画气泡。不支持或无法识别时使用聊天输入。该 API 兼容性有限，部分浏览器会通过浏览器厂商的在线服务识别，不能保证离线；参考 [MDN SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)。

## 仍然听不到？

检查双方都已开启听筒、未被系统静音、麦克风权限已允许，以及浏览器“恢复收听”提示。HTTPS 只解决权限；跨网络连接失败请按 [TURN 说明](TURN_VOICE_SETUP.md) 检查中继。真实手机双向语音与识别仍需实际设备验收。
