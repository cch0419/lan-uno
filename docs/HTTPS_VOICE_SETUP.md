# UNO：给现有部署开启 HTTPS 和麦克风

适用服务器：Ubuntu 22.04，公网 IP 39.104.71.170，项目目录 /root/workspace/uno。
已有游戏容器正常运行在 3000，80 和 443 已确认空闲。以下服务器命令均用 root 执行，逐条操作，报错先停止。

本流程先建立浏览器信任的 HTTPS 入口，再验证语音。HTTPS 解决麦克风权限；不同网络之间若不能建立语音连接，还需配置 TURN 中继，不能仅凭网页能打开判断语音已验收。

## 1. 放行 80、443【阿里云控制台】

在这台 ECS 的安全组入方向新增两条允许规则：
- TCP 80，来源 0.0.0.0/0：证书签发与自动续期验证。
- TCP 443，来源 0.0.0.0/0：HTTPS 网页和 WSS。

暂时保留原来的 3000，等 HTTPS 验证通过后再收紧。

## 2. 安装 Nginx 和新版 Certbot【服务器】

~~~bash
apt-get update
apt-get install -y nginx snapd curl
systemctl enable --now nginx snapd.socket
snap install --classic certbot
snap run certbot --version
~~~

Certbot 必须是 5.4 或更新版本，以支持公网 IP 的 webroot 验证。若提示 Certbot 已通过 Snap 安装，直接检查版本即可。安装/下载失败时停在这里，不改已有游戏容器。

检查主机防火墙：

~~~bash
ufw status
~~~

仅当 UFW 已启用时执行：

~~~bash
ufw allow 80/tcp
ufw allow 443/tcp
~~~

## 3. 配置证书验证入口【服务器】

创建验证目录和测试文件：

~~~bash
mkdir -p /var/www/lan-uno-acme/.well-known/acme-challenge
printf 'uno-acme-ok\n' > /var/www/lan-uno-acme/.well-known/acme-challenge/check
~~~

完整复制下面这段命令，创建本项目的 Nginx 配置：

~~~bash
cat > /etc/nginx/sites-available/lan-uno <<'EOF'
server {
    listen 80;
    server_name 39.104.71.170;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/lan-uno-acme;
        default_type text/plain;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $http_host;
    }
}
EOF

ln -sfn /etc/nginx/sites-available/lan-uno /etc/nginx/sites-enabled/lan-uno
nginx -t
systemctl reload nginx
~~~

Nginx 默认站点无需删除，这个配置通过 server_name 匹配你的公网 IP。

在 Windows 本机 PowerShell 验证公网入口：

~~~powershell
curl.exe --connect-timeout 10 http://39.104.71.170/.well-known/acme-challenge/check
~~~

必须看到 uno-acme-ok 才继续。如果超时，先检查安全组、UFW 和阿里云接入拦截提示；如果出现其他内容，先核对 Nginx 站点配置。

## 4. 申请公网 IP 的可信证书【服务器】

~~~bash
snap run certbot certonly --webroot --webroot-path /var/www/lan-uno-acme --ip-address 39.104.71.170 --preferred-profile shortlived --cert-name lan-uno-ip
~~~

首次运行时按提示填写邮箱、阅读并选择是否同意服务条款。申请成功后检查：

~~~bash
ls -l /etc/letsencrypt/live/lan-uno-ip/fullchain.pem /etc/letsencrypt/live/lan-uno-ip/privkey.pem
~~~

这一步申请正式可信证书，不使用 --staging。证书名字固定为 lan-uno-ip，下面的 Nginx 路径与它对应。

## 5. 开启 HTTPS 和 WebSocket 转发【服务器】

完整复制下面这段命令，更新本项目配置：

~~~bash
cat > /etc/nginx/sites-available/lan-uno <<'EOF'
server {
    listen 80;
    server_name 39.104.71.170;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/lan-uno-acme;
        default_type text/plain;
    }

    location / {
        return 301 https://39.104.71.170$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name 39.104.71.170;

    ssl_certificate /etc/letsencrypt/live/lan-uno-ip/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/lan-uno-ip/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location = /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $http_host;
    }
}
EOF

nginx -t
systemctl reload nginx
curl -I https://39.104.71.170/
~~~

应返回 200，且不能出现证书错误。不要加 -k 跳过验证。原来 UNO_ALLOWED_HOSTS 中的 39.104.71.170 仍适用，无需删除 Host/Origin 检查。

## 6. 配置自动续期和证书加载【服务器】

IP 证书有效期约六天，必须完成这一步。证书续期后只重载 Nginx，不必为了换证书重启 UNO 容器。

~~~bash
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/lan-uno-reload-nginx <<'EOF'
#!/bin/sh
set -eu
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
EOF

chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/lan-uno-reload-nginx
systemctl status snap.certbot.renew.timer --no-pager
snap run certbot renew --cert-name lan-uno-ip --dry-run --run-deploy-hooks
~~~

续期定时器应显示 active (waiting)，模拟续期应成功。如果定时器不存在、未启用或模拟续期失败，先处理该错误，不能省略自动续期。

80 端口和验证目录需要持续保留，后续续期仍会使用。

## 7. 验证麦克风和语音【电脑、手机】

所有人改用以下入口，不再使用 http://39.104.71.170:3000：

https://39.104.71.170

1. 浏览器应显示正常安全连接，没有证书警告。
2. 重新建立身份、创建房间。HTTP 和 HTTPS 的浏览器存储来源不同，旧身份不会自动迁移。
3. 两台设备加入同一房间，点击开启麦克风，并允许浏览器权限；同时确认听筒已开启。
4. 两台设备分别使用 WiFi 和手机流量，互相讲话，确认两边都能听到。
5. 再验证出牌和聊天，确保 WSS 转发正常。

电脑浏览器开发者工具 Console 可检查：

~~~javascript
window.isSecureContext
typeof navigator.mediaDevices?.getUserMedia
~~~

分别应为 true 和 "function"。Network 中 /ws 应通过 wss://39.104.71.170/ws 连接，成功升级状态为 101。

若能开麦但听不到：查看语音详情中的连接状态，当前默认没有配置公网 STUN/TURN。HTTPS 已完成不代表 WebRTC 必然能跨运营商直连，若连接失败，可按 [TURN 中继配置步骤](TURN_VOICE_SETUP.md) 安装中继并接入现有容器。若只有播放被浏览器阻止，先点击“恢复收听”。这里不填未经验证的公共 TURN 账号。

## 8. 统一 HTTPS 入口【服务器和阿里云控制台】

HTTPS 与对局验证成功后，在没有进行中对局时，将应用端口限制为本机访问：

~~~bash
cd /root/workspace/uno
cp compose.yaml /root/workspace/uno-compose-before-https.yaml
sed -i 's|"3000:3000"|"127.0.0.1:3000:3000"|' compose.yaml
docker compose config
~~~

确认输出中宿主机监听为 127.0.0.1:3000，再执行：

~~~bash
docker compose up -d --no-build --force-recreate uno
curl -I https://39.104.71.170/
~~~

这次容器重建会清空房间。随后撤销安全组的公网 TCP 3000 入站规则，保留 80、443 和原有 SSH 管理规则。后续更新继续保留这份服务器 Compose 配置。

参考：
- IP 证书和 Certbot 版本要求：https://letsencrypt.org/2026/03/11/shorter-certs-certbot
- Nginx WebSocket 转发：https://nginx.org/en/docs/http/websocket.html
- Certbot 续期钩子：https://eff-certbot.readthedocs.io/en/stable/using.html

本文提供可执行步骤，尚未连接服务器执行。实际证书签发、公网可达性和语音连通性需逐步验证。