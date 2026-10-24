# 跨网络 WebRTC / TURN（可选）

来自同事 PR #1 的语音采用 WebRTC mesh；服务器只转发信令，不存储或转发音频。HTTPS/WSS 的游戏隧道不自动成为 WebRTC 中继。多人同时说话时，每人需要连接其他语音伙伴，带宽开销会增长。

## 配置已有 STUN / TURN

在自己服务器的 `.env`（Compose）里填写一行 JSON。以下均为占位值，必须替换：

```dotenv
UNO_VOICE_ICE_SERVERS=[{"urls":"stun:turn.example.com:3478"},{"urls":["turn:turn.example.com:3478?transport=udp","turn:turn.example.com:3478?transport=tcp"],"username":"uno-user","credential":"replace-with-browser-turn-password"}]
```

然后 `docker compose up -d --force-recreate uno`，刷新双方页面、重新加入听筒。Node 直接启动时用终端环境变量设置该值，`npm start` 不自动读 `.env`。最多 8 项配置；`/voice-config.json` 会发送给浏览器，凭据对玩家可见，不能使用服务商管理密钥。长期公开部署应使用短期 TURN 凭据。

## 可选：在自己的 Linux 云主机安装 coturn

仓库保留 `scripts/setup-public-turn.sh`，需 root、apt、Docker Compose、已有运行中的游戏容器。它会安装/配置 coturn、备份原配置、生成密码、创建 `compose.override.yaml`、重建游戏容器，已有对局会丢失；已有 TURN 或其他 override 时先自行合并。**本次没有运行此脚本。**

确认目标主机是自己的后，设置真实参数执行，例如：

```bash
sudo env UNO_PROJECT_DIR=/opt/lan-uno UNO_PUBLIC_IP=203.0.113.10 bash scripts/setup-public-turn.sh
```

`203.0.113.10` 是文档示例 IP，必须换成自己的公网 IPv4。云安全组和防火墙需允许 3478 TCP/UDP、49152–65535 UDP；HTTPS 入口仍需 80/443。脚本使用 UDP 媒体中继，不等于所有限制网络都能连通；若网络只允许 HTTPS 出口，需要另行设计 TURN/TLS 及端口分配。

`.env`、`compose.override.yaml`、`/etc/lan-uno/voice.env` 包含凭据，不能提交或公开。脚本会修改服务配置，请在维护窗口由服务器管理员执行，不能在不相关主机上试跑。

## 验收

两台设备分处 Wi-Fi 和流量，均访问可信 HTTPS 地址并开启听筒：依次按住讲话，确认双方可听、松手后停麦、自己没有回声；随后测试三人、离房、重连和切后台。在浏览器 WebRTC 诊断中确认选中 relay 候选，才能判定 TURN 真正被使用。自动化信令测试不能代替这一步。
