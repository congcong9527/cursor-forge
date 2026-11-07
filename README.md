# CursorForge · Motion Grid 动效工场

多光标协作搭建网页的动效生成器：输入任意网址，自动还原该网站的搭建过程 ——
一群彩色鼠标光标先写出站点标题/简介/网址，再画出布局线、逐层搭起全部元素，
最终结晶为完整网页成品。单文件 HTML + Canvas 2D，零框架、无构建。

**在线体验**：https://mouse.livepartner.fans/

## 功能

- **网址一键生成**：粘贴网址 → 服务端无头 Chrome 真实渲染（含 JS、懒加载图片）→
  提取布局 → 自动编排 24 只光标的搭建动效
- **片头字幕**：网站标题 / 简介 / 网址由三只光标逐字拖出，带下划线扫线
- **像素级对齐**：搭建过程与最终成品逐像素一致（确定性随机手法 + 终点精确吸附）
- **多种数据通道**：本地站点包 / 服务端渲染 / 服务器网关 / 公共 CORS 代理 / 粘贴源码
- **多媒体素材**：图片 / 视频 / 音频附件全栈支持，localStorage 持久化
- **导出**：一键导出动效视频

## 部署

### 静态部分

`index.html` 是完整应用，任意静态托管即可；配合 `sites/` 站点数据包与 `assets/` 使用。

### 服务端（可选，启用完整采集能力）

```bash
# ① 同源抓取网关（纯 HTML 代理，绕开浏览器 CORS）
sudo cp server/fetch-gateway.js /www/cfcap/
sudo cp server/cursorfetch.service /etc/systemd/system/

# ② 无头 Chrome 真实渲染采集（百度/淘宝等 JS 重站需要）
npm i puppeteer   # CentOS 7 请用 node 16 + puppeteer 21（Chrome 116）
sudo cp server/capture.js /www/cfcap/
sudo cp server/cursorcap.service /etc/systemd/system/
sudo systemctl enable --now cursorfetch cursorcap
```

nginx 参考配置见 `server/nginx-mouse.conf`：`/api/fetch` → 127.0.0.1:8092、
`/api/capture` → 127.0.0.1:8093，`/capture/` 直出整页截图缓存。

服务器需要安装 Chrome 系统依赖与中文字体（否则截图中文为方块）：

```bash
yum install -y atk at-spi2-atk cups-libs libdrm libXcomposite libXdamage \
  libXfixes libXrandr libgbm libxkbcommon pango cairo alsa-lib nss \
  google-noto-sans-cjk-fonts
```

## 目录结构

```
index.html              应用本体（单文件，全部逻辑内联）
sites/                  本地站点数据包（布局 JSON + 整页截图）
assets/lp-full.png      内置演示站整页图
server/fetch-gateway.js 同源抓取网关（/api/fetch）
server/capture.js       无头渲染采集服务（/api/capture，puppeteer）
server/*.service        systemd 单元
server/nginx-mouse.conf nginx 参考配置
```

## 安全说明

网关带 SSRF 防护（拦截内网/本机地址），采集沙箱禁用第三方脚本越权；
如需公网部署，请自行加访问鉴权。
