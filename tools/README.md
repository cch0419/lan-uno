# 公网隧道工具

从 [Cloudflare 官方下载页](https://developers.cloudflare.com/tunnel/downloads/) 下载适合本机的 cloudflared。

Windows 64 位电脑通常使用 Windows amd64 版本，将下载的可执行文件重命名为 `cloudflared.exe` 并放在本目录。其他架构请选对应官方版本。

也支持系统 PATH 中的 `cloudflared`，或通过环境变量 `CLOUDFLARED_PATH` 指定可执行文件的完整路径。

工具只需安装在运行 UNO 服务的电脑上，朋友只需要浏览器。可执行文件不提交到 Git；游戏不会自动安装工具、修改路由器或防火墙。
