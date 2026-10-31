<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->

## 升级数据兼容（用户的硬性要求）

- 每次版本更新必须完整继承用户已保存的数据：全部历史/当前任务及完成、置顶、日期信息，任务说明、备注及图片，完整课表、草稿、设置与布局。不得因更新清空历史、重新生成示例、重置数据，或只迁移当前可见记录。
- 保持有效应用名 `task-board-widget`、`build.appId` 为 `com.lllleolin.taskboard`。不要添加会覆盖应用名的顶层 `productName`；`build.productName` 仅作打包显示名称。保持原有用户数据目录、默认持久会话、文件加载方式和 `minimal-task-widget-*-v1` 存储键。版本号不得参与数据目录或键名。
- 新字段使用向后兼容的默认值，并保留已有字段和未知扩展字段。确需变更数据格式时，先备份原始数据、验证完整迁移，再使用新格式；不得把解析失败的空数组或被过滤的残缺内容回写覆盖原记录。
- 升级回归使用隔离的持久用户目录：准备旧格式数据，关闭应用、更换程序文件、重启并核对原始任务/课程/草稿内容和历史查询。覆盖一次无关编辑后其余记录仍完整。禁止把真实用户目录当测试数据使用。
- 本机覆盖更新须先正常退出程序，将数据备份到安装目录之外，再替换程序文件并验证。备份、迁移或验证失败时不得继续覆盖旧数据。安装器保持 `deleteAppDataOnUninstall: false`，升级不传删除应用数据的参数。
- 继续按用户约定先提交 GitHub、更新本机运行目录；用户确认后才制作安装包和 Release。根目录 README 等并行修改单独保留，不混入无关提交。
