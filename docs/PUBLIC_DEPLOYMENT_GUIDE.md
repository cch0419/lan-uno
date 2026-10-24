# Docker / 云服务器部署（可选）

这些配置从同事 PR #1 合入，并改为可填写的地址，不绑定任何人的云主机。当前未实际部署。原来的 `npm start` 和 `npm run start:internet` 继续可用。

## 1. 准备

在自己的服务器安装 Docker Engine 和 Compose 插件，将项目放到 `/opt/lan-uno`。建议使用域名和可信 HTTPS；纯 HTTP 公网 IP 可以试玩牌局，但手机麦克风不可用。

复制 `.env.example` 为 `.env`，例如：

```dotenv
PORT=3000
UNO_BIND_IP=127.0.0.1
UNO_ALLOWED_HOSTS=uno.example.com
UNO_PUBLIC_URL=https://uno.example.com
UNO_VOICE_ICE_SERVERS=[]
```

把示例域名替换为自己的真实域名。若只在局域网用 Docker，绑定 IP 改为 `0.0.0.0`、PUBLIC_URL 留空，在 ALLOWED_HOSTS 填写设备实际访问的服务器 IP（多个用逗号分隔，无端口）。`.env` 不提交 Git。

## 2. 构建、测试、启动

```bash
cd /opt/lan-uno
docker compose config --quiet
docker build --target test -t lan-uno:test .
docker run --rm lan-uno:test
docker compose up -d --build
docker compose logs --tail=100 uno
```

只运行一个游戏实例；房间在内存中，容器重启会清空。Docker 的 test 阶段会执行当前完整测试集；测试失败不要上线。

## 3. HTTPS 入口

域名 A/AAAA 解析到自己的服务器。在服务器安装 Caddy，放行 TCP 80/443，将以下配置写进 Caddyfile（不要覆盖已有站点，按已有服务方式重载）：

```caddyfile
uno.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy 在域名、DNS 和端口满足要求时自动申请和续期证书；反向代理支持 WebSocket。保留原始 Host 和 Origin，不要把 Host 改为内部 IP；应用会校验配置的公网 Origin。参见 [自动 HTTPS](https://caddyserver.com/docs/automatic-https)、[反向代理](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。

打开 `https://uno.example.com`，双设备建房、出牌、刷新重连、聊天、发送表情包/图片，然后分别开启听筒验证语音。3000 绑定回环即可，不必直接对公网开放。

## 4. 跨网络语音

HTTPS 解决录音权限，WebRTC 还需要网络连通性。默认不依赖公共 STUN；同网可尝试直接连接。不同 Wi-Fi/流量互通失败时，在 `.env` 的 `UNO_VOICE_ICE_SERVERS` 填入自己可用的 STUN/TURN JSON，重新创建容器。完整步骤见 [TURN 说明](TURN_VOICE_SETUP.md)。不要把云服务 API 私钥当作 TURN 的浏览器凭据。

## 5. 更新和回退

先结束当前牌局，在项目目录备份 `.env` 与当前代码版本，切到通过测试的版本后重新执行测试、`docker compose up -d --build`。失败时切回备份版本重建。不要把自己的 `.env`、`.certs`、TURN 凭据上传仓库。

验证范围：本机 Node/WebSocket 自动化及浏览器界面；当前机器未安装 Docker，容器构建、证书签发和公网双向语音需要在目标服务器验收。
