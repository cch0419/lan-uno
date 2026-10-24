# LAN UNO 公网部署方案

适用环境：阿里云 ECS，Ubuntu 22.04，华北 5（呼和浩特），公网 IP `39.104.71.170`，已安装 Docker，暂无域名。

本文件保留总体方案。可直接执行的步骤以 [详细部署手册](PUBLIC_DEPLOYMENT_GUIDE.md) 和项目根目录的 Dockerfile、compose.yaml 为准；部署配置已准备，尚未连接服务器或修改应用实现。先按自己和朋友邀请对局设计，若要开放给所有人，需增加更完整的防滥用措施。

## 1. 推荐路径

第一阶段使用单个 Docker 容器提供公网试用入口：`http://39.104.71.170:3000`。现有前端会自动连接 `ws://39.104.71.170:3000/ws`，不必修改为固定服务器地址，也不必重写规则引擎。

第二阶段购买域名、按阿里云接入要求完成备案，通过 HTTPS/WSS 提供长期入口。届时复用已有 Nginx；没有反向代理时可使用 Caddy 自动管理证书。应用容器不再直接向公网开放 3000 端口。

第一阶段的 HTTP 入口用于短期验证，昵称、恢复令牌及游戏数据均为明文传输。长期使用应切换到 HTTPS；访问口令也不能替代传输加密。IP 证书属于另一条可行路线，但有证书工具、续期和云接入条件需要单独核验，本方案不依赖它。

## 2. 第一阶段架构

```text
玩家手机 / 电脑
    | HTTP 页面 + WebSocket 对局
    v
39.104.71.170:3000
    | 阿里云安全组 + 主机防火墙
    v
Docker 宿主机 3000 -> 容器 3000
    v
单个 Node.js 24 进程
    |-- 静态网页
    |-- /ws 实时连接
    |-- 会话与房间
    `-- 规则、排名、倒计时（内存）
```

主机不需要手动打开管理网页。朋友打开同一公网入口，创建或加入房间即可；房主权限属于浏览器会话。自己的电脑关机不影响游戏，云服务器和容器需要保持运行。

当前必须保持单个应用实例。所有会话、房间、牌堆和计时状态均在进程内存中，Docker/PM2 多副本不会共享状态；单纯粘性会话也不能让一个房间跨进程工作。第一版无需数据库或 Redis。

## 3. 现有代码与调整范围

### 当前已支持

- `UNO_ALLOWED_HOSTS` 可加入公网 IP 或域名，保留 Host 校验。
- 前端按访问地址连接 WebSocket；HTTPS 页面会自动使用 WSS。
- `UNO_OPEN_BROWSER=0` 或 `--no-open` 关闭自动打开浏览器。
- 消息大小限制、单连接消息限速、心跳、私有手牌、命令去重和断线恢复。
- 当前上限为 200 个 WebSocket 连接、100 个房间、500 个保留会话；这些是代码保护阈值，不是压测得出的承载能力。

### 第一阶段需要准备

1. 新增 `Dockerfile`、`.dockerignore`、`compose.yaml` 和部署说明。
2. 配置 `PORT=3000`、`UNO_ALLOWED_HOSTS=39.104.71.170`、`UNO_OPEN_BROWSER=0`。
3. 调整页面中“同一 WiFi / 局域网网址”的提示，统一显示实际访问入口。
4. 对朋友邀请使用，建议增加站点访问口令及失败尝试限速。当前四位房间号仅用于定位房间，不能作为密码。口令需要服务端验证，并覆盖 WebSocket 建连或身份握手，不能只隐藏前端按钮。现有代码尚不支持口令环境变量。
5. 保留当前玩法、私有手牌、排名和断线规则，不因部署改动游戏规则。

### 长期公开开放时再补充

- 房间密码或更难猜的邀请凭据，以及建房、入房、认证等命令级限速。
- 按可信来源获取客户端 IP 的策略：只有由本方代理转发时才使用其转发头，不能相信公网直连提交的任意 `X-Forwarded-For`。
- 连接建立速率和资源占用限制。当前的单连接消息限速不能阻止攻击者反复建立新连接。
- 健康检查、维护状态和必要监控；日志不记录恢复令牌、口令或他人私有手牌。

## 4. 部署文件草案

以下内容是后续实施模板，尚未创建为可执行部署文件。需在服务器确认端口空闲、Docker Compose v2 可用之后采用。

`Dockerfile`：

```dockerfile
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
USER node
EXPOSE 3000
CMD ["node", "server/index.js", "--no-open"]
```

`.dockerignore`：

```text
.git
node_modules
.npm-cache
.env
*.log
```

`compose.yaml`：

```yaml
services:
  uno:
    build: .
    restart: unless-stopped
    init: true
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      PORT: "3000"
      UNO_ALLOWED_HOSTS: "39.104.71.170"
      UNO_OPEN_BROWSER: "0"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

容器内应用继续监听 `0.0.0.0`，否则 Docker 端口映射无法正常访问。后续加反向代理时，通过宿主机 `127.0.0.1:3000:3000` 映射或 Docker 私有网络隔离应用端口。

上传项目和上述文件到例如 `/root/workspace/uno` 后，执行：

```bash
cd /root/workspace/uno
docker compose version
docker compose build
docker compose run --rm --no-deps uno node --input-type=module -e "import { createServer } from './server/index.js'; const app = await createServer(); await app.close(); console.log('server modules and assets OK');"
docker compose up -d
docker compose ps
docker compose logs --tail=100 uno
```

完整 `npm test` 应在源代码工作区执行。精简运行镜像只复制 `server`、`public` 和依赖，不含 `tests`，因此不能把镜像内运行 `npm test` 当成完整测试通过。

## 5. 阿里云和 Ubuntu 网络配置

- 确认 ECS 绑定并可使用公网 IP `39.104.71.170`。
- 在该实例实际使用的阿里云安全组中，按目标访问人群放行入方向 TCP 3000。
- 检查主机防火墙和 Docker 转发规则，保持原有 SSH 管理入口可用。Docker 发布端口可能绕过部分 UFW 常规规则，不能只检查 UFW；公网暴露范围应以安全组及实际连通测试共同确认。
- 不必为 UNO 开放数据库端口、UDP 或额外 WebSocket 端口。
- 不要假定 IP 或非标准端口能绕过运营商、云平台的接入要求；若出现拦截，按阿里云实际提示核查。

## 6. 域名与 HTTPS 阶段

1. 选择域名，并按中国大陆云服务器网站接入要求完成备案及阿里云接入配置。备案与证书是两件事。
2. 将游戏子域名解析到 `39.104.71.170`。
3. 反向代理监听 80/443，为正式域名提供证书，HTTP 跳转到 HTTPS。
4. 所有网页与 `/ws` 使用同一域名；反向代理保留原始 Host，支持 WebSocket Upgrade，连接空闲超时须大于当前 15 秒心跳间隔，例如 300 秒。
5. 将正式域名加入 `UNO_ALLOWED_HOSTS`，应用 3000 仅对本机或代理容器开放，关闭安全组中公网 3000 入口。
6. 统一对外分享 HTTPS 域名。IP、域名、HTTP、HTTPS 的浏览器存储来源不同，首次切换后需要重新建立身份；应在没有进行中对局时切换。

若服务器已有其他网站，复用现有代理配置，避免额外服务争用 80/443。仅新增 UNO 站点配置，不替换现有站点。

## 7. 验收与维护

首次验收：

- 使用两台设备分别通过手机流量和其他网络访问公网入口，完成建房、加入和整局排名。
- 检查房主只管理模式、+4 质疑及其私有证据、刷新恢复、标签接管、掉线暂停和倒计时超时行为。
- 模拟多房间，确认状态、手牌和权限互不串房。
- 若新增访问口令，确认未认证的客户端无法绕过网页直接用 WebSocket 建房入房，错误尝试受到限制。
- HTTPS 阶段确认没有混合内容错误，证书有效，WebSocket 正常返回 101 并能跨越多个心跳周期持续在线。

当前已有 45 项自动化测试通过；Docker、公网反向代理、口令及真实跨网络验收仍需实施后执行。资源从现有服务器开始，若新增低负载实例，可将 1 核 1GB 作为试运行起点；并发承载需依据实际内存、带宽和多房间压测确定。

日常使用：

```bash
docker compose ps
docker compose logs --tail=100 uno
```

更新前保存上一个可用镜像或明确的版本标签。确认无进行中对局后，更新代码、执行完整测试、构建并重建容器；失败则切回旧镜像。任何进程重启、容器重建或回滚都会清空当前房间和对局，自动重启也不会恢复存档。无需为了第一版公网对局立即引入持久化。
