# UNO 公网部署步骤

服务器：阿里云 Ubuntu 22.04，公网 IP：39.104.71.170。项目目录：/root/workspace/uno。

按顺序完成下面三部分。标注“本机”的命令在 Windows PowerShell 执行，其余在服务器执行。以下登录、上传和服务器命令统一使用 root 账号。

## 一、安装 Docker

### 1. 登录服务器【本机】

~~~powershell
ssh root@39.104.71.170
~~~

### 2. 检查是否已经安装【服务器】

~~~bash
docker --version
docker compose version
~~~

**如果两条都能显示版本，跳过安装命令，直接进入第二部分。**

### 3. 安装 Docker 和 Compose【服务器】

未安装时，使用 Docker 官方软件源安装。以下命令按 Ubuntu 22.04 编写，使用 root 执行：

~~~bash
apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu jammy stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
~~~

确认安装成功：

~~~bash
docker --version
docker compose version
docker run --rm hello-world
~~~

看到版本号和 Hello from Docker!，继续下一步。任何命令报错时，先处理错误再继续。

## 二、部署项目

### 1. 上传部署包【本机】

另开一个 Windows PowerShell 窗口执行：

~~~powershell
Set-Location E:/uno/lan-uno
ssh root@39.104.71.170 "mkdir -p /root/workspace"
scp ./artifacts/lan-uno-deploy.tar.gz root@39.104.71.170:/root/workspace/lan-uno-deploy.tar.gz
~~~

上传进度达到 100% 后，回到服务器窗口。

### 2. 解压项目【服务器】

项目解压到 /root/workspace/uno。如果你已直接上传项目文件，确认 Dockerfile、compose.yaml、package.json、server 和 public 就在该目录下，然后跳过解压命令。

~~~bash
mkdir -p /root/workspace/uno
tar -xzf /root/workspace/lan-uno-deploy.tar.gz -C /root/workspace/uno
cd /root/workspace/uno
docker compose config
~~~

配置已经准备好，无需手写 Dockerfile 或修改前端地址。docker compose config 正常输出配置、没有错误即可。

### 3. 测试并启动【服务器】

逐条执行，测试通过后再启动：

~~~bash
cd /root/workspace/uno
docker build --target test -t lan-uno:test .
docker run --rm lan-uno:test
~~~

测试预期：pass 45、fail 0。

~~~bash
docker compose up -d --build
docker compose ps
~~~

服务显示 Up 或 running，且包含 3000 → 3000 端口映射，即启动成功。

### 4. 放行端口【阿里云控制台】

进入这台 ECS 关联的安全组，新增入方向规则：

| 项目 | 填写内容 |
| --- | --- |
| 授权策略 | 允许 |
| 协议 | TCP |
| 目的端口 | 3000/3000，或界面要求的 3000 |
| 来源 IPv4 | 0.0.0.0/0 |
| 描述 | UNO |

再检查服务器防火墙：

~~~bash
ufw status
~~~

如果显示 inactive，无需操作。如果已经启用，执行：

~~~bash
ufw allow 3000/tcp
~~~

## 三、验证部署

### 1. 服务器检查

~~~bash
cd /root/workspace/uno
curl -I -H 'Host: 39.104.71.170:3000' http://127.0.0.1:3000/
~~~

返回 HTTP/1.1 200 OK 表示网页服务和 Host 配置正常。

如果失败，查看启动日志：

~~~bash
docker compose logs --tail=100 uno
~~~

### 2. 浏览器检查

电脑浏览器打开：

http://39.104.71.170:3000

以上地址使用 http，能看到游戏首页后，输入昵称、创建房间。此 HTTP 部署方式仅能玩牌，手机麦克风需要可信的 HTTPS。启用语音前请按 README 的“房间语音聊天”配置 HTTPS（直接配置证书或使用 HTTPS 反向代理），反向代理必须转发 WebSocket；公网语音在无法直连时还需要配置 STUN/TURN。

### 3. 公网对局检查

1. 手机关闭 WiFi，使用移动数据打开同一个地址。
2. 输入另一个昵称，填写电脑创建的四位房间号。
3. 房主在大厅将每回合时间设为 15 秒并保存，再开始游戏。
4. 双方分别出牌、摸牌，确认状态同步。
5. 等待一次回合超时，确认自动摸牌并换人。
6. 刷新手机页面，确认恢复原座位和手牌。
7. 完成一整局，确认最终排名正常。

以上全部通过，公网部署即完成。SSH 窗口可以关闭，Docker 会继续运行。

本次部署使用当前版本的 HTTP 入口，没有访问密码；知道地址的人可以访问和建房。
