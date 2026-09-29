# 主线 / 支线
就一句话，我受够了各种各样的todolist里面乱七八糟的功能了
![界面预览](page-screenshot.png)

## 就做这些

- 记录主线、支线待办和截止日期
- 查看并编辑每周课表；不需要时可以关闭
- 勾选完成，并为任务补充简短说明
- 内容保存在当前浏览器本地，不会上传
- 支持日、周、月及自定义周期，五种界面语言和六种主题
- 随手记自动保存，支持粘贴图片、拖入任务；主面板与课表可以拖动、缩放和锁定

## 使用

下载或克隆仓库，直接用现代浏览器打开 `index.html`。无需构建或安装依赖。更换设备或清理浏览器数据前，请自行备份；本项目不提供云同步。

## 许可与素材

项目源代码以 MIT License 发布，见 [LICENSE](LICENSE)。主题插画和其他视觉素材不因源代码许可而自动转让或获得再许可；如需再分发，请先确认各素材的权利状态。ANU 校徽素材的来源及许可见 [`themes/ANU-crest-attribution.txt`](themes/ANU-crest-attribution.txt)：Wikimedia Commons，CC BY-SA 4.0。


## 桌面安装包

在 GitHub Releases 下载 Windows 安装程序，或下载 macOS 通用 DMG（同时支持 Apple Silicon 与 Intel Mac）。安装后应用数据保存在本机，不会上传。

macOS 安装包目前未使用 Apple Developer ID 签名与公证；首次打开时，macOS 可能会显示安全提示。可在系统设置中确认后打开应用。

桌面版通过托盘显示、隐藏或退出，主面板与课表分别支持置顶；设置中可切换开机自启动。网页与桌面版的数据分别保存在各自本地环境，不会自动互通。桌面面板当前在主显示器范围内移动。

## 开发与验证

使用 Node.js 22 或更新版本：

```sh
npm ci
npx playwright install chromium
npm run verify
npm start
```

`npm run verify` 检查脚本语法、素材路径和版本一致性，并运行桌面逻辑及浏览器交互测试。测试使用隔离的浏览器上下文；功能覆盖和人工验收边界见 [tests/README.md](tests/README.md)。Playwright 只用于开发测试，不进入发布包；网页仍可直接打开，无需依赖或构建。

有桌面会话时可另运行 `npm run test:electron`，使用临时独立数据目录验证真实 Electron 窗口和跨窗口同步。

Windows 安装包使用 `npm run dist:win` 构建。macOS 通用包由 macOS GitHub Actions 生成图标后构建。主题原图保留在仓库，发布包只包含应用实际使用的背景、校徽和许可文件。

## 版本管理

日常改动使用独立分支和 PR；推送及 PR 均自动执行测试。版本变更同时更新 `package.json`、`package-lock.json` 和 [CHANGELOG.md](CHANGELOG.md)。

合并并确认检查通过后，为对应提交创建与包版本一致的 `v*` 标签。发布流程先运行全部自动测试、校验标签，再构建 Windows / macOS 安装包；两个构建均成功后发布 GitHub Release。手动从分支运行只生成构建产物，不发布 Release。旧标签保持不变，修复版本使用新标签。
