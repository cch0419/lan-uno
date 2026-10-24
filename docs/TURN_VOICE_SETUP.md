# 跨网络语音：配置 TURN 中继

适用：39.104.71.170，Ubuntu 22.04，项目 /root/workspace/uno，HTTPS 已正常，Windows Edge 和手机不同网络时出现“部分语音未连通”。

诊断脚本执行后显示 undefined 是正常返回值；脚本等待新连接成功后才会打印统计。连接失败警告意味着需要继续排查连通性。本配置为当前缺少 STUN/TURN 的部署补上中继，实际双向语音仍需完成第 3 步验证。

## 1. 放行阿里云安全组

为这台 ECS 新增入方向允许规则，来源 0.0.0.0/0：

| 协议 | 目的端口 |
| --- | --- |
| TCP | 3478/3478 |
| UDP | 3478/3478 |
| UDP | 49152/65535 |

保留现有 80、443、SSH 规则。中继端口不能通过现有 Nginx HTTP 配置代替，必须直接允许上述 TCP/UDP 连接。

## 2. 上传并运行配置脚本

Windows 本机 PowerShell 执行：

~~~powershell
Set-Location E:/uno/lan-uno
scp ./scripts/setup-public-turn.sh root@39.104.71.170:/root/workspace/uno/setup-public-turn.sh
ssh root@39.104.71.170
~~~

服务器执行：

~~~bash
sed -i 's/\r$//' /root/workspace/uno/setup-public-turn.sh
bash /root/workspace/uno/setup-public-turn.sh
~~~

脚本会安装 coturn，识别服务器 IPv4，配置公网/内网映射，自动生成中继口令，并通过 Compose 覆盖配置让 UNO 获取 STUN/TURN。口令保存到服务器 /etc/lan-uno/voice.env，终端不打印口令。原来的 Nginx、证书、基础 Compose 端口设置保持原样。

脚本会重新创建 UNO 容器，当前房间会清空，请在无人对局时执行。若检测到其他 Compose 覆盖文件，或 coturn 已运行但没有本脚本的凭据文件，会停止并保留现状。已有停止状态的 coturn 配置会先备份再替换。

预期最终显示 coturn 已运行、uno 服务 running，以及 iceServerCount 为 2，urls 包含 stun、turn 的 UDP 和 TCP 地址。中途报错先停止并发送报错，不要贴口令文件或完整的 /voice-config.json。

## 3. 刷新并验证

1. 两端关闭旧网页，统一重新打开 https://39.104.71.170。
2. 重新建房、加入，开启麦克风并允许权限，确认听筒已开启。
3. Edge 与手机保持不同网络，双方持续讲话，确认双向声音正常。
4. 保持通话约一分钟，再检查是否还有“部分语音未连通”警告。

若仍失败，服务器执行以下两条，把输出发来：

~~~bash
systemctl is-active coturn
journalctl -u coturn -n 40 --no-pager
~~~

不能只看页面显示“已连接”就结束验收，必须确认双方实际听到声音。

## 配置说明

- 现有代码已支持 UNO_VOICE_ICE_SERVERS，无需重新构建游戏镜像。
- 新建的 compose.override.yaml 只引用服务器上的口令文件。后续普通 docker compose 命令会自动加载它；更新项目时保留这个文件和 /etc/lan-uno/voice.env。
- 脚本中的固定账号用于朋友间试运行，配有分配数量、带宽限制，并阻止中继访问回环、内网和云元数据地址。TURN 会使用服务器带宽，且浏览器需要拿到中继凭据；不要把口令提交到 GitHub。长期公开开放时应结合访问控制和短期凭据调整。
- 这一版提供 TURN/UDP 和 TURN/TCP 3478，不提供 TURN/TLS 443。如果所在网络还封锁 3478，需要进一步配置其他可达的中继入口。

脚本尚未在远程服务器执行，本机只做语法和配置静态检查。

参考：[coturn 配置说明](https://github.com/coturn/coturn/blob/4.5.2/examples/etc/turnserver.conf)、[Compose 自动合并覆盖配置](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/)。