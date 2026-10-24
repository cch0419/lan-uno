# 公网部署方案与实施过程

来源：同事 PR #1（f291869），已合入 Docker 运行/测试双阶段镜像与 Compose，保留本机服务器和隧道方案。没有执行云端部署。

| 阶段 | 实现 | 验收 |
| --- | --- | --- |
| 本机/局域网 | npm start；电脑自动打开管理页 | 多设备加入、管理者不参赛 |
| 电脑公网隧道 | npm run start:internet；公网 HTTPS/WSS | 不同网络实时出牌，旧隧道失效处理 |
| 可选容器 | Dockerfile、compose.yaml、.env.example | Docker test 阶段及单容器对局 |
| 可选云端 | 自己的云主机、域名、HTTPS 反向代理 | Host/Origin、WS 升级、刷新重连 |
| 跨网语音 | WebRTC；按网络配置 STUN/TURN | 不同网络双向收听、松手停麦、断线清理 |

必须保持服务端权威校验、手牌隔离、单实例内存房间、麦克风显式按住开启。不得为上线覆盖用户本地未提交的游戏功能。

风险：HTTP IP 不允许手机录音；单位/校园网络可能拦截隧道域名或 WebRTC；HTTPS 不能代替 TURN；房间不跨服务重启保存；没有账号认证的小游戏不宜直接当作大型开放社区服务。

操作步骤见 [部署教程](PUBLIC_DEPLOYMENT_GUIDE.md)，HTTPS 和语音说明见 [HTTPS](HTTPS_VOICE_SETUP.md)、[TURN](TURN_VOICE_SETUP.md)。
