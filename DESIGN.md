# 局域网 Web UNO：完整设计方案与开发计划

版本：1.1 · 2026-10-24

目标：一台电脑启动服务，同局域网其他设备通过浏览器访问主机 IP 和端口，输入昵称、创建或加入房间，完成 UNO 对战。运行期间不依赖公网、账号系统或数据库。

新增跨网目标：仍用自己的电脑作为唯一游戏服务器，通过公网隧道让其他 WiFi／移动数据上的玩家加入。局域网模式保留；跨网模式需要第三方隧道中转，不部署云端游戏服务。

## 跨网络联机补充设计：自己的电脑作为服务器

本节优先于原始章节中“仅局域网”的约束。原先独立的跨网方案已合并到本文；本次不实施云部署、P2P、数据库或多实例。

### 架构与使用方式

```text
朋友浏览器（不同 WiFi / 移动数据）
       │ HTTPS 网页 + WSS 游戏消息
       ▼
Cloudflare Quick Tunnel 临时公网入口
       │ 电脑主动建立的出站隧道
       ▼
本机 cloudflared → http://127.0.0.1:3000
       ▼
原 Node.js 单进程：HTTP + WebSocket + 内存房间 + 规则裁判

电脑房主浏览器 → http://localhost:3000（自动打开，仍可选择仅管理）
局域网玩家     → http://主机内网IP:3000（保持可用）
```

所有实际玩家优先统一使用同一个公网网址。localhost、内网 IP、公网域名分别存储浏览器身份；主机本地管理身份和自己手机参赛身份可以独立。电脑需要保持开机、唤醒、联网，公网启动窗口也需保持运行。Node 进程停止后所有内存房间清空。

Cloudflare Quick Tunnel 不要求自有域名或账号，生成的临时域名每次启动可能变化，仅用于试玩，不保证持续可用。朋友只使用浏览器；只有服务器电脑安装 cloudflared。不同运营商的可达性、延迟必须用真实手机移动数据和朋友网络验收。

### 必须实现：网络配置、校验与邀请

- 普通启动 `npm start` / `start.bat` 继续使用原局域网模式。
- 公网启动 `npm run start:internet` / `start-internet.bat` 同时运行游戏服务和自己创建的 cloudflared 子进程。
- `UNO_PUBLIC_URL` 可供已有手动隧道使用，必须是纯 HTTPS Origin，不允许路径、凭据、查询、片段或通配符；自动 Quick Tunnel 模式会忽略旧的该变量。
- 继续兼容 `UNO_ALLOWED_HOSTS` 精确主机名列表。HTTP 和 WS 握手都验证 Host；公网 WebSocket Origin 必须精确匹配配置的 HTTPS Origin。禁止用未验证的 X-Forwarded-Host、X-Forwarded-Proto 放宽校验。
- 如果本机隧道重写 Host，仅允许 TCP 来源为 loopback、目标为 localhost／loopback Host 且 Origin 精确等于已配置公网 Origin 的情况。
- `GET /api/config` 返回 `{mode, publicUrl, tunnelStatus}`，仅含公开邀请信息，响应禁用缓存。不包含令牌、服务器环境变量、私人地址列表或手牌。
- `mode` 为 `lan/internet`；`tunnelStatus` 为 `off/starting/ready/configured/failed/stopped`。`configured` 表示手动地址配置，不代表已检测隧道可达。
- 大厅优先展示公网网址，支持复制“网址 + 四位房间号”。连接中和子进程停止时不提供可复制的旧链接。本机地址不可作为局域网邀请复制。
- 前端继续按网页协议使用 WS/WSS。电脑 HTTP 管理页无须切到公网域名，公网地址通过配置接口更新。
- 公网运行提示明确说明“电脑与公网窗口需保持运行”，不改变已有玩法和倒计时规则。

### 必须实现：启动与退出生命周期

```text
校验 PORT
  → 查找 CLOUDFLARED_PATH / tools/cloudflared.exe / PATH
  → --version 检查可运行；缺失则显示官方安装说明，不静默安装
  → 启动 Node HTTP/WS；端口被占用则失败，不操作已有进程
  → 启动自己拥有的 cloudflared 子进程（隐藏辅助窗口，禁止 shell 拼接）
  → 自动打开 localhost 管理页
  → 从分块日志中提取严格匹配的 https://*.trycloudflare.com 地址
  → 检测 Registered tunnel connection 后发布链接
  → 动态更新白名单与公开配置，不重启 Node、不清空房间
```

日志可能分多段到达，必须按行缓冲。只接受工具生成的确切域名，不能匹配任意网页 URL；公网工具只从官方来源取得。临时运行配置保存在内存，地址不写死到应用源代码或持久化配置。测试截图中的一次性示例网址不作为有效入口。

cloudflared 异常退出时将公网入口标记为 failed，清除界面可分享状态，Node 和局域网对局继续运行。工具本身处理连接重试；短时上游故障不承诺立即被界面识别，由现有 WebSocket 心跳和重连反馈实际状态。60 秒仍未建连时给出诊断提示。

Ctrl+C／正常终止只关闭本启动器创建的隧道和 UNO 服务，清理计时器与连接。不通过进程名批量终止 Node/cloudflared，不改防火墙、路由器或用户已有隧道配置。

### 依赖、操作与风险

从 [Cloudflare 官方下载页](https://developers.cloudflare.com/tunnel/downloads/) 取得适合本机的 cloudflared。Windows 可将官方可执行文件命名为 `tools/cloudflared.exe`，也可使用 PATH 或 `CLOUDFLARED_PATH`。可执行文件、缓存和私人环境文件均不提交。

手动隧道仍可使用：先取得 HTTPS 网址，设置 `$env:UNO_PUBLIC_URL = 'https://实际域名'`，再 `npm start`；需自行保持隧道运行。自动入口直接使用 `npm run start:internet`。

| 风险 | 处理 |
| --- | --- |
| 临时网址变化 | 重启后重新分享；新域名身份独立，需要重新进房 |
| 运营商或网络阻断 Cloudflare | 在不同网络实测；失败保留局域网运行，后续可适配其他支持 HTTP/WS 的隧道 |
| 页面能开但不能出牌 | 检查 WSS、Host/Origin、`/ws` Upgrade 转发和连接日志 |
| 电脑休眠／断网／服务退出 | 公网游戏不可用；保持电脑和窗口运行 |
| Node 重启 | 房间丢失，必须重新建房；不承诺恢复原局 |
| cloudflared 本地配置影响 Quick Tunnel | 提示检查 `.cloudflared` 配置，不擅自覆盖或删除 |
| 网址被转发给陌生人 | 有网址的人能访问；四位房间号仅定位房间，长期使用可选加入场口令 |

Quick Tunnel 官方限制包括无可用性保证、临时域名、最多 200 个进行中的请求和不支持 SSE；本项目使用 WebSocket，仍须实测隧道完整链路。

### 过程计划与验收

1. 在 `codex/internet-multiplayer` 实现配置策略与公网 HTTP/WS 握手测试。
2. 实现隧道启动、日志解析、动态网址和退出清理；用受控模拟进程验证失败路径。
3. 完成大厅邀请与复制、启动说明，回归手机和局域网模式。
4. 原有规则／联机测试与新增公网配置、Origin、防伪造请求头、域名轮换、隧道生命周期测试通过。
5. 真实跨网验收：至少两台设备使用不同网络完成一局，检查出牌、摸牌、选色、+4、UNO、超时、名次、短时掉线和私人手牌隔离。
6. 记录验证证据与限制，用户确认后再合并 main。测试通过不代表可以证明完全无缺陷。

可选扩展：固定隧道域名、入口口令、延迟指标、二维码；这些都继续让用户电脑作为游戏服务器，不列入本次必须范围。

官方参考：[Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)、[隧道 Origin 参数](https://developers.cloudflare.com/tunnel/reference/origin-parameters/)、[WebSocket 支持](https://developers.cloudflare.com/network/websockets/)。

## 最新玩法与界面修订（优先于原始标准规则方案）

2026-10-24 追加：本局结束条件改为只剩一个未完赛玩家。`finishOrder` 记录已出完牌的 ID，`activePlayers` 从固定 `seatOrder` 中排除这些玩家；跳过、反转、罚牌目标和双人特例均按剩余玩家计算。最后一张 +4 的名次在质疑／接受结算后确认。最终 `ranking` 含所有人的名次和余牌数，`lastPlayerId` 是最后一人。完赛玩家保留圆桌座位，不再接受出牌，不因退出或断线暂停游戏；保存 `playerNames` 以便会话过期后仍能展示名次。第一名只是已确认的首位完赛者，不是全局结束信号。空牌堆仅结束当前摸牌回合，不判整局平局。

新增房间 `turnSeconds`，默认 45，允许整数 15～120；房主使用 `ROOM_CREATE` 或等待大厅 `ROOM_UPDATE` 设置。`turnClock` 保存 `gameId/turnId/phase/startsAt/deadlineAt/paused/remainingMs/readyRemainingMs`，所有快照附带 `serverTime` 供浏览器估算时间差。回合切换留出 2200ms 动画缓冲再开始倒计时；动作前与定期清理均检查截止时间，超时只处理一次，再为新回合创建时钟。客户端仅显示倒计时，不能提交“自动超时”命令。普通回合自动摸一张并结束；起始选色自动选择手中最多的颜色，再摸一张结束；+4 回应自动接受四张罚牌。未完赛玩家掉线冻结剩余时间，重连恢复；UNO 声明不改变回合或计时。

动画调整为约 1050ms 的抬牌、弧线飞行、落桌过程，连续摸牌间隔 100ms。牌落桌立即显示，再继续播放罚牌；印章／中央特效和回合／UNO 提示约两秒。公开事件新增 `timeout` 与 `player_finished { playerId, rank }`，仅用于展示，仍由服务端统一决定结果。

根据实际游玩反馈，目前使用本房自定义规则：摸一张即结束回合，不能立即出新牌，没有 PASS_TURN；彩色功能牌仅按当前生效颜色匹配，不按功能跨色；数字牌仍可同数字；黑色变色／+4 可跨色。移除 CATCH_UNO、unoWindow、after_draw 与抓漏处罚。手动 UNO 保留，使用 unoDeclaredIds 去重，手牌增多后清除声明。原始章节保留作为最初方案记录，不代表这些功能仍启用。

游戏状态视图新增 seatOrder、eventSequence；公开日志事件携带递增 sequence，并包含跳过／处罚目标和反转方向。动画消费已确认事件，不能决定游戏逻辑，不向其他玩家暴露摸到的牌；重连、重复快照与日志截断不会造成旧特效反复播放。暂停／离房取消旧动画，动画积压时优先追上最新状态。

手机为主要交互端：圆桌视角旋转使本人始终在底部，其他玩家按固定座次均匀围坐；当前玩家发光边框、呼吸动画和“出牌中”，上下箭头显示方向。牌桌背景直接跟随红／黄／绿／蓝，大号颜色文字辅助识别。底部手牌横滑，保留大号“摸一张／摸完结束回合”按钮。

视觉反馈：手牌飞向中央、牌堆飞向目标座位／本人手牌；跳过在目标座位盖禁止印章、+2 在目标座位盖 +2 印章；反转、变色、+4 在中央出现特效；轮到本人和任何人 UNO 有明显浮层提示。浮层不截获触摸，动作期间避免重复提交；支持减少动态效果偏好。

本文保存本项目讨论确定的 13 章方案。第 8、9 章的基础代码框架由项目中的实际源码承载，避免文档示例与可运行代码产生两套实现。开发交付的实际范围和验证结果以 README.md 为准。

## 功能修订：房主可只管理、不参赛

房间成员与实际参赛玩家分开计算。房主创建房间时可通过 `ROOM_CREATE.hostParticipates`（默认 true）选择是否参赛；在等待大厅通过 `ROOM_UPDATE.hostParticipates` 修改本人的参与状态，开局后固定本局座位。

- `Room.playerIds` 保存所有成员，新增 `Room.spectatorIds: string[]` 保存不参赛的管理／旁观成员；参赛玩家为两者的差集。移交房主只转移管理权，不改变参赛身份。
- 容量 2～10 只限制实际参赛人数；开局要求至少 2 名实际玩家且这些玩家全部在线。非参赛房主可以加 10 名玩家同时在房间中。
- 创建游戏仅传入参赛 ID。旁观者收到空手牌、公开牌桌和全部禁用的游戏动作；不允许抓漏或获取私人质疑证据。
- 状态新增 `participantCount`，成员与 `you` 新增 `isParticipating`。前端按此显示人数、身份、旁观说明及管理控件。
- 断线暂停与超时中止仅由实际参赛玩家触发；管理／旁观成员退出不会改变当前游戏。暂停恢复只检查本局 seatOrder，旁观者重连不能解除真实玩家离线造成的暂停。
- Node 服务进程与房主网页独立。房主网页关闭后自动移交权限，游戏仍运行；电脑服务停止或休眠则所有设备断线。

以下章节中的「成员」「玩家」按此修订区分，原来的隐私、规则和权限约束继续适用。

## 启动与安装修订

项目 `.npmrc` 使用项目内 `.npm-cache` 与官方包仓库，避开系统 npm 缓存目录的权限问题。Windows `start.bat` 检查 ws 是否可导入，缺失或损坏时执行 npm ci，安装失败不继续启动。无需全局升级 npm。

服务监听成功后，请求默认浏览器打开本机管理入口；用户仍可选择昵称、创建房间及切换房主参与状态，不自动创建房间或修改权限。浏览器打开失败不影响服务，终端提供手动地址。`UNO_OPEN_BROWSER=0` 或 `--no-open` 可关闭自动打开；端口占用时提示先停止原服务。

## 章节1：项目整体架构设计

### 1.1 第一版与后续范围

| 模块 | 第一版必须实现 | 可选扩展 |
| --- | --- | --- |
| 连接 | 局域网 HTTP、WebSocket、连接状态 | HTTPS、自动发现 |
| 身份 | 昵称、浏览器令牌、在线状态 | 头像、统计 |
| 房间 | 4 位房间号、2～10 人、退出、移交、解散 | 密码、公开列表 |
| 游戏 | 108 张牌、完整单局、UNO、+4 质疑 | 自定义规则、机器人 |
| 结算 | 单局胜者、返回大厅、再开一局 | 500 分累计比赛 |
| 页面 | 首页、等待大厅、游戏桌、基础手机适配 | 动画、声音、主题 |
| 恢复 | 刷新恢复、短暂掉线保留、超时清理 | 重启存档恢复 |

采用经典 108 张牌的单局模式。第一位出完牌的玩家赢得本局；500 分跨局比赛后续增加。

### 1.2 架构与数据流

```text
局域网主机 192.168.1.100:3000
└─ Node.js 单进程
   ├─ HTTP：本地 HTML / CSS / JS
   ├─ WebSocket /ws：身份、房间、命令、状态
   ├─ 纯规则引擎：校验、出牌、抽牌、处罚、结算
   └─ 内存：sessions、rooms、game
             ↑↓ 同一局域网
       电脑 / 手机 / 平板浏览器
```

玩家点击 → 客户端命令 → 服务端身份及规则校验 → 原子更新 → revision 递增 → 为每个玩家生成独立视图 → WebSocket 推送 → 客户端渲染。

服务端是唯一权威：客户端不能决定牌堆、他人手牌、处罚、回合或胜负。第一版推送完整的“本人可见状态”，不做增量补丁；这不等于广播整个服务端对象。

### 1.3 通信原理

网页 `http://主机IP:3000`，WebSocket `ws://主机IP:3000/ws`，共用 TCP 端口。WebSocket 支持双向主动推送，比轮询更适合回合广播。房间号只在当前服务实例内有效，不会自动发现局域网服务器。

可访问的条件：监听正确网卡、端口放行、设备间允许互访、地址正确。应用不注册公网服务；是否能从其他网络访问仍由主机网卡、路由和防火墙决定。

## 章节2：详细技术选型说明 + 备选方案

| 层 | 推荐 | 理由 |
| --- | --- | --- |
| 运行时 | Node.js 24 LTS | 稳定、前后端同语言 |
| HTTP | Node 内置 http | 少依赖 |
| 实时通信 | ws | 与 HTTP 共用端口 |
| 前端 | 原生 JavaScript ES Modules | 降低维护门槛 |
| 样式 | 普通 CSS；需要时本地构建 TailwindCSS | 离线运行，无 CDN |
| 数据 | Map、对象、数组 | 内存即可 |
| 测试 | node:test | 直接测试纯规则和真实协议 |

Node + Socket.IO 可简化重连和房间广播，但需要专用客户端；Python 或 Go 适合熟悉对应语言的团队。PeerJS/WebRTC 能建立浏览器间数据通道，但仍需要信令，且房主迁移、状态一致性和网络连接建立更复杂。完全离线时必须本地提供信令与网页，不能把 PeerJS 当成天然无服务器方案。

安装依赖通常需要网络；游戏运行不需要。脚本、字体、样式和图片全部由本机提供。

## 章节3：核心数据结构定义

下面是设计类型；实际 JavaScript 字段由源码定义，保持相同职责。

```ts
type Color = 'red' | 'yellow' | 'green' | 'blue';
type Card =
  | { id: string; kind: 'number'; color: Color; value: number }
  | { id: string; kind: 'skip' | 'reverse' | 'draw2'; color: Color }
  | { id: string; kind: 'wild' | 'wild4'; color: null };

interface Player {
  id: string;                    // 服务端唯一身份，昵称可以相同
  nickname: string;              // 1～16 个 Unicode 字符
  roomCode: string | null;
  online: boolean;
  disconnectedAt: number | null;
  joinedAt: number;
}
interface Session {
  playerId: string;
  resumeToken: string;           // 高熵随机，只有本人可见
  socket: unknown | null;
  recentRequests: Map<string, unknown>; // 有界幂等缓存
}
interface Room {
  code: string;                  // 0000～9999，保留前导零
  hostId: string;
  maxPlayers: number;            // 2～10
  playerIds: string[];
  status: 'waiting' | 'playing' | 'finished';
  revision: number;
  game: GameState | null;
}
interface GameState {
  id: string;                    // 每局唯一，拒绝上一局的消息
  phase: 'choose_initial_color' | 'turn' | 'after_draw'
    | 'wild4_response' | 'finished';
  paused: boolean;               // 独立于 phase，重连保留原阶段
  seatOrder: string[];
  dealerId: string;
  currentPlayerId: string;
  direction: 1 | -1;
  turnId: number;
  hands: Record<string, Card[]>; // 私密
  drawPile: Card[];              // 私密
  discardPile: Card[];
  activeColor: Color | null;
  drawnCardId: string | null;
  unoWindow: null | { id: string; targetPlayerId: string };
  pendingWild4: null | {
    id: string; actorId: string; targetId: string;
    previousColor: Color; chosenColor: Color;
    wasLegal: boolean;           // 私密，不能广播
    handBeforePlay: Card[];      // 只在质疑时给质疑者
  };
  provisionalWinnerId: string | null;
  winnerId: string | null;
  endReason: string | null;
  dryPassPlayerIds: string[];
}
```

客户端视图只包括：房间号、版本、房主、玩家昵称/在线状态/手牌数、本人手牌、顶牌、当前颜色、方向、当前行动者、阶段、牌堆数量、公开的待回应目标、可用操作。禁止发送其他人的手牌、牌堆顺序、令牌、+4 判定结果。

浏览器 localStorage 保存令牌。同一浏览器配置文件、同一网站地址恢复为同一玩家，新标签页接管旧连接。无痕窗口、清除存储、不同浏览器或不同来源地址不能被无账号系统认作同一个人。

## 章节4：房间模块详细设计

### 创建与加入

```text
create(player, max):
  验证身份、未在房间、max 为 2～10 整数、房间数量上限
  随机起点扫描未占用的 4 位编号，不无限重试
  创建房间 → 创建者入房并任房主 → 推送视图

join(player, code):
  验证 /^\d{4}$/ 和房间存在
  已在本房间 → 幂等返回
  已在其他房间 → 拒绝
  游戏进行中或结算中 → 拒绝新加入
  人数满 → 拒绝
  加入 → revision++ → 推送视图
```

房主可在等待页修改容量、开始游戏、移交在线成员、解散房间；结束后可返回大厅。开局要求房主操作、2～上限人数、所有人在线。第一版不增加准备按钮。

### 退出、掉线与销毁

等待页退出立即移除；房主退出转交最早加入的在线玩家；无人则销毁。游戏中主动退出会中止本局，无胜者，剩余玩家返回大厅，这是异常处理约定而非 UNO 牌面规则。

掉线立即标记离线并暂停正在进行的游戏，身份和手牌保留 60 秒。期间恢复令牌有效则恢复座位和原阶段；全部在线后继续。超时移除，若正在对局则中止并返回大厅。房主掉线可转交在线成员，回来不自动夺回权限。所有成员离线超时或房主解散时，清理房间、定时器和成员引用。离线无房间会话与请求缓存也需定期清理。

## 章节5：UNO 游戏核心规则引擎设计

### 5.1 固定规则

经典 108 张、每人 7 张、一次出一张、不能叠加处罚、不抢出、不用 7/0 换手。允许有可出牌时主动抽一张；抽牌后只能出刚抽的牌。+4 允许冒险使用，由后继玩家决定是否质疑。没有自动 UNO。

### 5.2 牌组、洗牌与开局

```text
buildDeck():
  每色：1 张 0；1～9 各 2 张；跳过、反转、+2 各 2 张
  4 张 wild + 4 张 wild4
  每张唯一 ID，断言 108 张

shuffle(cards):
  i 从 length-1 到 1
  j = 随机整数 [0,i]
  交换 i,j （Fisher–Yates）

start():
  抽牌比大小选庄，功能牌 0，并列重抽；选庄牌归回
  洗牌；每人发 7 张；翻起始牌
  数字 → 庄家下一位
  跳过 → 跳过庄家下一位
  +2 → 庄家下一位抽 2 并跳过
  反转 → 改方向，庄家先行
  wild → 庄家下一位选颜色并行动
  wild4 → 放回洗混重翻
```

生产随机用服务端 crypto.randomInt，测试允许固定随机源或构造牌局。

### 5.3 回合与出牌

```text
next(player, steps=1):
  index = seatOrder.indexOf(player)
  return seatOrder[((index + direction*steps)%n+n)%n]

beginTurn(player):
  currentPlayerId = player; turnId++
  phase = turn; drawnCardId = null

matches(card):
  wild / wild4 → true（+4 合法性另记）
  同 activeColor → true
  两张均数字且数值相同 → true
  同一种功能牌 → true
  否则 false

play(actor, cardId, chosenColor, declareUno):
  验证未暂停/未结束、gameId、turnId、当前玩家、阶段
  验证 cardId 在本人手里
  after_draw 阶段只允许 drawnCardId
  验证匹配，wild 必须带有效颜色
  +4 保存出牌前手牌、原颜色与合法性
  验证全部成功后关闭旧 UNO 窗口
  移除牌 → 压弃牌堆 → 设置当前颜色
  2 张变 1 张：本次手动声明则发提示，否则创建 UNO 窗口
  执行功能效果 → 判定胜负 → 提交
```

数字牌不能仅因 kind 同为 number 而匹配。

### 5.4 功能牌与抽牌

```text
number / wild → next(actor)
skip → next(actor, 2)
reverse → 方向取反；2 人时 actor 再行动，否则 next(actor)
draw2 → next(actor) 抽 2；之后跳过受罚者
wild4 → pendingWild4，后继玩家选择接受或质疑

drawOne(actor):
  验证 turn 阶段且轮到自己；关闭旧 UNO 窗口
  抽 1 张，若需则先回收弃牌
  能出 → after_draw，只允许出此张或 PASS_TURN
  不能出 → 下一回合
  无牌可抽 → 记录无牌跳过，检查停滞

pass(actor):
  仅当前玩家在 after_draw 阶段允许
  切下一回合
```

罚抽不获得即时出牌机会；两人时跳过/反转让出牌者再行，+2 或接受 +4 后亦回到出牌者。

### 5.5 +4 合法性与质疑

```text
legal = 出牌前不存在颜色等于 activeColor 的手牌
同数字/同功能但不同颜色不影响合法性

accept(target, pendingId):
  只允许处罚目标响应当前 pending
  关闭旧 UNO 窗口；抽 4；清 pending；跳过
  结算待定胜者

challenge(target, pendingId):
  验证目标和 pending；关闭旧 UNO 窗口
  仅给质疑者出牌前手牌证据
  不合法 → 出牌者抽 4，质疑者正常行动
  合法 → 质疑者抽 6 并跳过
  清 pending；结算待定胜者
```

不预先禁用冒险 +4，否则质疑机制失去意义。证据使用冻结的出牌前快照，不受 UNO 罚抽等后续动作影响。待响应期间拒绝普通出牌/抽牌。

### 5.6 UNO 与并发

剩两张时手动点 UNO，下一次出牌原子携带 declareUno；剩一张且窗口未关闭时可补报。系统不自动声明。网络版将“下一玩家开始行动”定义为下一有权玩家首个有效出牌、抽牌、接受或质疑命令；自动处罚与广播不关闭窗口。

```text
callUno(actor, windowId):
  验证窗口、目标为本人、仍 1 张
  关闭窗口 → 发布提示

catchUno(actor, windowId):
  验证窗口、同房、不是本人、目标仍 1 张
  先关闭窗口 → 目标抽 2 → 发布提示
```

所有动作按服务器接收并执行顺序串行裁决，不信客户端时间戳。两人抓漏只处罚一次；补报与抓漏谁先有效到达谁生效；无效命令不得关闭窗口。

### 5.7 牌堆耗尽与胜负

```text
drawCards(player, n):
  重复 n 次：
    牌堆空 → 保留弃牌顶，其余洗回
    仍无可抽 → 停止
    抽一张加入玩家
  返回实际数量

每次提交断言：手牌总量 + 抽牌堆 + 弃牌堆 = 108；ID 唯一

checkWinner():
  0 张 → 记待定胜者
  +4 待响应 → 延后结算
  最后 +2 → 先完成罚抽
  待定胜者仍 0 且无待结算 → finished
```

极端所有牌在手里：抽实际可用数量、不造牌、不无限循环；完整一轮无人出牌且无人能抽则停滞无胜者结束。这是产品兜底约定。

引擎不依赖网络和 DOM；在状态副本上校验执行，成功后整体提交。房间内更新不穿插 await，异常丢弃副本。

## 章节6：前后端通信协议设计

```json
{"type":"PLAY_CARD","requestId":"unique-id","payload":{"gameId":"g1","turnId":8,"cardId":"c7","chosenColor":"blue","declareUno":false}}
```

请求身份从连接确定，不采信自报玩家 ID。普通动作携带 gameId/turnId；UNO 带 windowId；+4 带 pendingId。房间 revision 用于状态排序，不作为所有命令的刚性前置条件，避免在线状态广播使正常点击过期。

| 客户端事件 | 载荷 | 处理 / 接收者 |
| --- | --- | --- |
| HELLO | nickname, resumeToken? | 新建/恢复会话；本人 SESSION，房间在线状态 |
| GET_STATE | 无 | 本人最新视图 |
| ROOM_CREATE | maxPlayers | 校验、建房；本人状态 |
| ROOM_JOIN | code | 校验、加入；全房视图 |
| ROOM_LEAVE | 无 | 退出、必要时中止；本人和原房间 |
| ROOM_UPDATE | maxPlayers | 房主等待页改容量；全房 |
| HOST_TRANSFER | targetPlayerId | 房主转给在线成员；全房 |
| ROOM_CLOSE | 无 | 房主解散；全房 |
| GAME_START | 无 | 房主开局；每人私有视图 |
| CHOOSE_INITIAL_COLOR | gameId, color | 起始 wild 选色；全房 |
| PLAY_CARD | gameId, turnId, cardId, chosenColor?, declareUno? | 原子出牌；全房 |
| DRAW_CARD | gameId, turnId | 抽一张；全房 |
| PASS_TURN | gameId, turnId | 放弃刚抽牌；全房 |
| CALL_UNO | gameId, windowId | 补报；全房 |
| CATCH_UNO | gameId, windowId | 抓漏；全房 |
| ACCEPT_WILD4 | gameId, pendingId | 罚抽并跳过；全房 |
| CHALLENGE_WILD4 | gameId, pendingId | 质疑；全房结果，证据仅本人 |
| RETURN_TO_LOBBY | 无 | 房主清本局；全房 |

| 服务端事件 | 载荷 | 接收者 |
| --- | --- | --- |
| SESSION | playerId, resumeToken | 本人 |
| COMMAND_RESULT | requestId, ok, code?, message? | 请求者 |
| STATE | PlayerView 或 null | 分别向每人生成 |
| NOTICE | eventId, kind, message, revision | 房间 |
| CHALLENGE_EVIDENCE | pendingId, handBeforePlay | 质疑者 |
| ROOM_CLOSED | reason | 原成员 |
| SESSION_REPLACED | reason | 被接管旧连接 |

必须有 JSON/类型校验、8KB 消息上限、连接限速、ping/pong、有限请求去重缓存、旧局/旧回合拒绝。相同 requestId 不重复执行；相同 ID 不同内容拒绝。重连先取状态，不盲目重放游戏动作。NOTICE 只辅助提示，STATE 包含足够的恢复信息。

## 章节7：页面路由与 UI 模块设计

首页、等待大厅、游戏桌由服务端状态驱动，Hash 路由可作为后续地址表现层，不承担权限判断。

- 首页：昵称、连接状态、人数上限、创建按钮、4 位编号输入、加入按钮。
- 大厅：房间号、地址、人数、玩家/在线列表、房主、开始、移交、退出、解散。
- 对战：对手牌数、顶牌、抽牌堆、方向、当前颜色、当前行动者、自己的横向手牌、抽牌/跳过/UNO、消息区。
- +4：处罚目标看到接受/质疑；其他玩家等待。证据只给质疑者。
- 结算：胜者或中止原因、返回大厅。

可出牌高亮；非当前玩家不能普通出牌但可以抓漏；抽后仅新牌可操作；变色牌先选色再提交完整动作；掉线/暂停时禁用动作。颜色带文字和图形辅助，不能只靠颜色。昵称用 textContent。手机手牌横向滚动。HTTP 下复制功能可失败，保留可选地址文本。

## 章节8：服务端代码框架

```text
server/index.js       HTTP/WS、入口与生命周期
server/rooms.js       会话、房间、幂等、清理与视图
server/game.js        牌组与纯规则引擎
public/              全部本地静态资源
tests/               引擎、协议、多人集成测试
```

入口职责：监听 `0.0.0.0:3000`，固定静态文件白名单，WebSocket `/ws`，解析命令，调用房间管理器，统一错误响应，心跳和离线清理。允许的 Host/Origin 来自实际网卡 IP、本机名与显式配置，避免任意外部网页调用本地服务。

```js
// 结构示意；实际可运行代码见 server/。
const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
server.on('upgrade', validateOriginAndUpgrade);
wss.on('connection', attachSessionAndHandleCommands);
server.listen(port, '0.0.0.0');
```

规则引擎 `applyCommand(state, actorId, command)` 返回新状态、公开事件、私有证据。绝不把 room/session/socket 对象直接 JSON 序列化发给客户端。服务重启房间清空。

## 章节9：前端代码框架

```text
public/index.html    页面语义结构
public/styles.css    桌面与手机布局，无外部样式
public/app.js        连接、消息、状态渲染、操作事件
```

```js
// 按当前访问地址连接，不写死 localhost。
const socket = new WebSocket(
  `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`
);
// 手动点击 UNO 后，将声明和下一张牌一起提交。
send('PLAY_CARD', { gameId, turnId, cardId, chosenColor, declareUno });
```

使用浏览器 localStorage 保存令牌和昵称；被其他标签页接管后停止自动重连，避免互相抢占。正常网络故障用有上限的指数退避。UI 状态由服务器快照决定，命令 pending 期间防双击，超时主动恢复连接以获取实际结果。

UNO 本地选择绑定 gameId/turnId，手牌或回合变化清除；普通在线更新不要清除。颜色选择使用自定义面板；证据弹窗使用 textContent 创建卡牌。出牌失败显示服务端原因。

## 章节10：局域网部署教程

1. 在主机安装 Node.js 24 LTS。
2. 项目目录执行 `npm install`（已有锁文件时 `npm ci`）。
3. 执行 `npm start`。
4. 主机访问 `http://localhost:3000`。
5. Windows 执行 `ipconfig`，查看正在使用的 WiFi/以太网 IPv4；macOS 在网络设置查看；Linux 用 `ip -4 addr`。
6. 其他设备访问 `http://主机内网IP:3000`，例如 `http://192.168.1.100:3000`。

Windows 管理员 PowerShell 放行受信任专用网络端口：

```powershell
New-NetFirewallRule -DisplayName 'LAN UNO TCP 3000' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Private -RemoteAddress LocalSubnet
```

不关闭整个防火墙。跨子网需要管理员配置具体来源和路由。其他设备的 localhost 指向它自己，不是主机。初次安装通常需网络，离线部署需提前准备 Node 和依赖；运行不依赖公网。

| 风险 | 解决办法 |
| --- | --- |
| 只主机可访问 | 检查监听地址和防火墙 |
| 同 WiFi 不互通 | 关闭访客/AP 隔离，改可互通网络 |
| 跨网段失败 | 路由/ACL 配置，或同网段 |
| 页面正常 WS 失败 | 检查 /ws、Upgrade、地址协议 |
| IP 变动 | DHCP 地址保留 |
| 主机睡眠 | 游戏期间保持唤醒 |
| 端口占用 | 设置 PORT 并同步防火墙 |
| HTTPS 混合内容 | HTTPS 使用 wss |
| 重启丢局 | 内存模式预期，重新建房 |

## 章节11：边界异常处理清单

- 昵称空/过长拒绝；HTML 当文本；同昵称允许。
- 房间号保留零，满员/不存在/进行中给明确错误；重复加入幂等。
- 权限只在服务端裁决，非房主不能管理，非当前玩家不能普通操作。
- 伪造 cardId、旧局消息、旧回合消息、失效 windowId/pendingId 拒绝且状态不变。
- 双击去重；再次用新 requestId 发送同牌也会因持牌/阶段校验失败。
- 抽后旧牌不能出；不能叠罚牌；无牌不死循环。
- UNO 竞争只成功一次，+4 证据快照不随罚抽变化。
- 刷新恢复，新标签接管；旧 close 事件不影响新 socket。
- 多人掉线全恢复才继续；超时中止。
- 房间号复用由 gameId/身份进一步隔离。
- 限制消息体、频率、未认证等待、会话缓存和慢客户端队列。
- 清理房间、离线身份、请求结果和计时器，避免内存增长。

## 章节12：扩展优化方向与完整过程计划

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M0 | HTTP/WS、本地页面 | 两设备连接 |
| M1 | 玩家、房间、权限 | 多人大厅同步 |
| M2 | 牌组、发牌、基础回合、隐私投影 | 内部规则流转 |
| M3 | 功能牌、双人、UNO、+4、起始、结算 | 完整单局用例 |
| M4 | 重连、暂停、超时、去重、限速 | 故障不破坏状态 |
| M5 | 页面完善、手机基本可用、部署文档 | 真实局域网验收 |

M0～M2 是内部阶段，不把仅数字牌的演示当完整 UNO。基础版完成单局核心功能；未完成的验证或功能在 README 明确列出。

建议顺序：通信 → 房间/身份 → 可测试的纯规则 → 私有视图 → 游戏 UI → UNO/+4 交互 → 恢复 → 真机联调。

可选第二阶段：动画、音效、头像、二维码、表情。第三阶段：累计积分、战绩、机器人、回合时限、密码和观战。第四阶段：明确标为自定义的叠罚、7/0、抢出。第五阶段：启动器、自启动、存档、HTTPS、P2P 实验。

无需数据库、Redis、微服务、Kubernetes、复杂前端框架或公网账号。

## 章节13：测试用例清单

### 房间与身份

- R01 2/10 人上限可用，1/11/小数拒绝。
- R02 前导零、编号碰撞、编号耗尽能正确处理。
- R03 不存在/满员/重复加入/已在其他房间返回明确结果。
- R04 非房主管理拒绝，人数不足不能开局。
- R05 房主退出移交，无人销毁；主动解散清所有成员。
- R06 刷新恢复、双标签接管，旧 socket 不能操作。

### 牌组与核心规则

- G01 108 张唯一、数量分布正确、2～10 人各 7 张且守恒。
- G02 同色/同数字/同功能可出，其他拒绝。
- G03 非本人回合、伪造卡牌、不完整选色均无副作用。
- G04 双向越界、双人反转/跳过、各起始功能牌。
- D01 主动抽牌可用，抽后只能出新牌或跳过，不可重复抽。
- D02 不可出抽牌自动换人，+2 抽 2 且跳过，不能叠加。
- D03 回收保留顶牌，总量/ID 守恒，无牌可回收不死循环。

### +4 与 UNO

- W01 无同色合法；异色同数字/功能不影响；有同色允许冒险但记录违法。
- W02 接受抽 4；质疑成功出牌者抽 4且目标行动；失败目标抽6并跳过。
- W03 非目标/重复 pending 拒绝；证据只给质疑者。
- W04 最后一张 +4 等结算；UNO 罚抽不改变质疑证据。
- U01 手动原子 UNO、忘喊窗口、补报、抓漏。
- U02 双人抓漏只罚一次；补报/抓漏服务端顺序确定胜负。
- U03 下一有效动作关闭窗口，非法动作不关闭。

### 联机、恢复、隐私与交付

- N01 多客户端状态一致，10 客户端各自只有自己的手牌。
- N02 普通 STATE 无牌堆顺序/他人手牌/令牌/+4 判定。
- N03 重复请求不重复执行，旧局消息拒绝。
- N04 断线暂停、限时恢复、超时中止、多掉线、旧 close 事件。
- N05 服务重启恢复失效给提示，不错误还原旧局。
- N06 断开互联网仍可局域网玩，主机休眠显示断线。
- N07 恶意 JSON/超大消息/洪泛不使进程退出。
- N08 至少两台真实设备完成整局；10 客户端压力与恢复验证。

自动测试与浏览器检查不能替代不同物理设备的 WiFi/防火墙验收；尚未进行的真机检查需如实列出。

## 规则与技术参考

- [Mattel 经典 108 张规则](https://service.mattel.com/instruction_sheets/W2085-Eng.pdf)
- [Mattel 抽牌、+4、UNO 规则](https://service.mattel.com/instruction_sheets/GDJ85-Eng.pdf)
- [Mattel 双人规则](https://service.mattel.com/instruction_sheets/J4299-0520.pdf)（仅采用双人通用规则，不引入该版本特殊牌）
- [ws 官方文档](https://github.com/websockets/ws)
- [Node.js 发布状态](https://nodejs.org/en/about/previous-releases)
- [PeerJS 文档](https://peerjs.com/client/getting-started)
