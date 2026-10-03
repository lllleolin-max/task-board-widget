# 主线 / 支线

把今天最重要的主线、顺手处理的支线和每周课表放在一个轻量面板里。适合个人日常待办与课表查看，无需账号。

> 就一句话，我受够了各种各样的 todolist 里面乱七八糟的功能了。

English: A small local task board for main tasks, side tasks and a weekly schedule. Use it in a browser or as a Windows/macOS desktop app; no account or cloud sync is required.

**[下载桌面版](https://github.com/lllleolin-max/task-board-widget/releases/latest)** · [浏览器使用](#浏览器使用) · [首次使用](#首次使用) · [数据保存](#数据保存)

![界面预览](page-screenshot.png)

## 就做这些

- 记录主线、支线待办和截止日期
- 查看并编辑每周课表；不需要时可以关闭
- 勾选完成，并为任务补充简短说明
- 内容保存在当前浏览器本地，不会上传
- 支持日、周、月及自定义周期，五种界面语言和六种主题
- 随手记自动保存，支持粘贴图片、拖入任务；主面板与课表可以拖动、缩放和锁定

## 浏览器使用

下载仓库 ZIP 并解压，或运行：

```sh
git clone https://github.com/lllleolin-max/task-board-widget.git
cd task-board-widget
```

用现代浏览器打开目录中的 `index.html`，即可看到任务面板。无需 Node.js、构建或安装依赖。浏览器浮窗功能依赖浏览器支持；需要独立桌面窗口时可使用安装包。

## 首次使用

1. 在「主线」或「支线」旁点击加号，添加任务与截止日期。
2. 点击任务标题编辑；勾选圆圈将任务标为完成，展开后可补充说明。
3. 按需添加课程；不用课表时可在设置中关闭。
4. 关闭后用同一个浏览器和原文件位置重新打开，检查任务仍在，再开始记录日常内容。

## 数据保存

任务和设置使用本地 `localStorage` 保存。浏览器版与桌面版分别保存，不会自动同步；换浏览器、无痕窗口、清理数据或移动网页文件可能影响原数据的读取。

当前版本没有内置导入/导出备份流程。迁移前请另外保存重要任务和课程信息，并核对迁移后的内容；不要把它作为重要资料的唯一副本。本项目不提供云同步或团队协作。

## 许可与素材

项目源代码以 MIT License 发布，见 [LICENSE](LICENSE)。主题插画和其他视觉素材不因源代码许可而自动转让或获得再许可；如需再分发，请先确认各素材的权利状态。ANU 校徽素材的来源及许可见 [`themes/ANU-crest-attribution.txt`](themes/ANU-crest-attribution.txt)：Wikimedia Commons，CC BY-SA 4.0。


## 桌面安装包

在 [GitHub Releases](https://github.com/lllleolin-max/task-board-widget/releases/latest) 下载 Windows `.exe` 安装程序，或 macOS 通用 `.dmg`（同时支持 Apple Silicon 与 Intel Mac）。安装包无需 Node.js。安装后应用数据保存在本机，不会上传。

Windows 安装完成页默认勾选「安装后启动」和「开机自动启动（当前用户）」，点击「完成」即应用选择；两项可分别取消。以后仍可在应用设置中切换自启动。静默升级保留现有自启动设置，卸载时清理当前用户的启动项。

macOS 安装包目前未使用 Apple Developer ID 签名与公证；首次打开时，macOS 可能会显示安全提示。可在系统设置中确认后打开应用。

Windows 安装包也未进行发布者签名，可能出现 SmartScreen 提示。请从上面的官方仓库下载并核对来源。

桌面版通过托盘显示、隐藏或退出，主面板与课表分别支持置顶；设置中可切换开机自启动。网页与桌面版的数据分别保存在各自本地环境，不会自动互通。桌面面板当前在主显示器范围内移动。

Windows 版支持在两个面板间直接点击操作。主体和课表无论是否 Pin，都在系统显示桌面或收起窗口后保留显示：未 Pin 时其他应用可以覆盖，Pin 后始终置顶。Pin 只控制窗口层级，不控制桌面可见性；主动从托盘隐藏或退出后不会自动弹回。

## 从源码启动桌面版

先安装 Git 和 Node.js；发布工作流使用 Node.js 22。克隆并进入仓库后执行：

```sh
npm ci
npm start
```

预期打开 Electron 桌面窗口。依赖安装需要联网；可通过托盘菜单退出，macOS 也可使用应用菜单 Quit 或 `Cmd+Q` 结束应用。

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

Windows 本地验证使用 `npm run pack:win`，只生成 `dist/win-unpacked` 运行目录，不制作安装包。直接更新已安装目录时先退出应用，将同次构建的程序文件一起更新；用户数据保留在原数据目录。Windows 安装包使用 `npm run dist:win` 构建。macOS 通用包使用 `npm run dist:mac`，并需按 [发布工作流](.github/workflows/release.yml) 准备应用图标。主题原图保留在仓库，发布包只包含应用实际使用的背景、校徽和许可文件。

Windows 的系统桌面检测使用固定版本 Koffi，原生模块随安装包提供，无需另装运行环境；macOS 包排除该模块。网页依然没有运行依赖。

## 版本管理

日常改动使用独立分支和 PR；推送及 PR 均自动执行测试。版本变更同时更新 `package.json`、`package-lock.json` 和 [CHANGELOG.md](CHANGELOG.md)。

开发阶段先同步本地程序和 GitHub，使用开发版本号验证；收到明确的发布确认后，再制作安装包、创建正式版本标签和发布 Release。

合并并确认检查通过后，为对应提交创建与包版本一致的 `v*` 标签。发布流程先运行全部自动测试、校验标签，再构建 Windows / macOS 安装包；两个构建均成功后发布 GitHub Release。手动从分支运行只生成构建产物，不发布 Release。旧标签保持不变，修复版本使用新标签。
## 反馈

通过 [Issues](https://github.com/lllleolin-max/task-board-widget/issues) 提交系统版本、浏览器或桌面版、复现步骤及预期结果。请勿附上私人任务内容。
