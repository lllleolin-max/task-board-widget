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

当前主分支没有内置导入/导出备份流程。迁移前请另外保存重要任务和课程信息，并核对迁移后的内容；不要把它作为重要资料的唯一副本。本项目不提供云同步或团队协作。

## 许可与素材

项目源代码以 MIT License 发布，见 [LICENSE](LICENSE)。主题插画和其他视觉素材不因源代码许可而自动转让或获得再许可；如需再分发，请先确认各素材的权利状态。ANU 校徽素材的来源及许可见 [`themes/ANU-crest-attribution.txt`](themes/ANU-crest-attribution.txt)：Wikimedia Commons，CC BY-SA 4.0。


## 桌面安装包

在 [GitHub Releases](https://github.com/lllleolin-max/task-board-widget/releases/latest) 下载 Windows `.exe` 安装程序，或 macOS 通用 `.dmg`（同时支持 Apple Silicon 与 Intel Mac）。安装包无需 Node.js。安装后应用数据保存在本机，不会上传。

macOS 安装包目前未使用 Apple Developer ID 签名与公证；首次打开时，macOS 可能会显示安全提示。可在系统设置中确认后打开应用。

Windows 安装包也未进行发布者签名，可能出现 SmartScreen 提示。请从上面的官方仓库下载并核对来源。

## 从源码启动桌面版

先安装 Git 和 Node.js；发布工作流使用 Node.js 22。克隆并进入仓库后执行：

```sh
npm ci
npm start
```

预期打开 Electron 桌面窗口。依赖安装需要联网；Windows 关闭窗口退出，macOS 使用应用菜单 Quit 或 `Cmd+Q` 结束应用。Windows 本地构建使用 `npm run dist:win`；macOS 构建使用 `npm run dist:mac`，并需按 [发布工作流](.github/workflows/release.yml) 准备应用图标。桌面发布包由 GitHub Actions 在推送 `v*` 版本标签时构建并发布。

## 反馈

通过 [Issues](https://github.com/lllleolin-max/task-board-widget/issues) 提交系统版本、浏览器或桌面版、复现步骤及预期结果。请勿附上私人任务内容。
