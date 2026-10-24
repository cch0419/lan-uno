# UNO 上传新版部署包后重新部署

服务器：39.104.71.170。项目目录：/root/workspace/uno。

以下按旧版本已成功部署编写。逐条执行，报错时先停止。更新容器会清空当前房间，请在没有人对局时操作。

## 1. 上传新版部署包【Windows 本机】

打开 PowerShell，执行：

~~~powershell
Set-Location E:/uno/lan-uno
scp ./artifacts/lan-uno-deploy.tar.gz root@39.104.71.170:/root/workspace/lan-uno-deploy.tar.gz
~~~

上传到 100% 后，登录服务器：

~~~powershell
ssh root@39.104.71.170
~~~

## 2. 解压新版项目【服务器】

~~~bash
cd /root/workspace/uno
cp compose.yaml /root/workspace/uno-compose-before-update.yaml
tar -xzf /root/workspace/lan-uno-deploy.tar.gz -C /root/workspace/uno
cp /root/workspace/uno-compose-before-update.yaml compose.yaml
~~~

这会更新源码，并保留服务器原来的端口和环境配置。

## 3. 测试新版代码【服务器】

继续使用之前的 DaoCloud 镜像地址：

~~~bash
sed -i 's|^FROM node:24-bookworm-slim|FROM m.daocloud.io/docker.io/library/node:24-bookworm-slim|' Dockerfile
docker compose config
docker build --target test -t lan-uno:test .
docker run --rm lan-uno:test
~~~

当前版本预期 69 项测试通过、fail 0。测试通过后再继续。

## 4. 重新构建并启动【服务器】

~~~bash
docker compose build uno
docker compose up -d --no-build --force-recreate uno
~~~

## 5. 验证部署

在服务器执行：

~~~bash
docker compose ps
docker compose logs --tail=100 uno
curl -I -H 'Host: 39.104.71.170:3000' http://127.0.0.1:3000/
~~~

服务应显示 Up 或 running，日志没有启动错误，curl 返回 HTTP/1.1 200 OK。若原来改过宿主机端口，用实际端口验证。

浏览器打开（已按 [HTTPS 语音配置步骤](HTTPS_VOICE_SETUP.md) 配置后，统一使用 https://39.104.71.170）：

http://39.104.71.170:3000

电脑按 Ctrl+F5 刷新；手机关闭页面后重新打开。确认新版界面出现，然后用两台设备建房、加入、出牌和发送聊天消息，确认双方同步正常，更新即完成。