# 数据保存与升级验证

2026-11-11 的运行现场确认了 Windows 本机重复显示空白的原因。桌面启动与 MSIX 应用内启动的 Taskboard 报告相同的 `userData` 路径，但快照文件的物理路径和文件标识不同。先前的恢复与验收命中了 MSIX `LocalCache/Roaming` 副本，Explorer 启动仍读取原 AppData 中缺少任务、课程键的快照。本机恢复须从 Explorer 环境备份两处并将完整数据写回原目录。Windows 的文件重定向行为见 [Microsoft Learn](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes#appdata-operations-on-windows-10-version-1903-and-later)。

隔离测试也覆盖数据库缺少较新日志时读回旧记录的路径。独立快照可以识别这类有效但过时的数据，并恢复最后确认的完整值。

桌面版现在在原用户目录的 `data-safety/` 下保存完整原始键值快照，位置不随版本变化。主进程串行提交，每次提交带修订号和 SHA256；临时文件写入并刷新到磁盘后原子替换，同时保留上一有效快照。未知字段、历史任务、图片和草稿都按原始字符串保存，不按当前界面筛选。

页面脚本运行前，preload 先与安全快照核对。发现存储内容回退或缺失时，先另存原始观察值，再恢复快照。合法删除使用墓碑记录，防止旧数据库带回已删除键。两份快照均不可读取时阻止修改，不将空结果回写。

从 dev.6 起，桌面页面始终读取主进程确认的原始值，localStorage 只作兼容镜像。先确认快照写入，再更新本窗口和其他窗口；不再先修改浏览器数据再回滚。桌面页面不监听浏览器 storage 事件，因而延迟空值事件、镜像被清空或不可访问不能清空运行中的任务和课表。主进程通知携带修订号，每个键分别拒绝较旧消息；旧窗口写入冲突时接收已确认值并保留表单供重试。初始化完成前另一个窗口的保存仍可正常提交，preload 在加载页面前再取一次最新原始值。浏览器版继续使用原有 localStorage 路径。

真正的读取失败显示持续的重新加载提示，不伪装成没有任务的新面板。`data-safety/events.log` 只记录时间、阶段与错误码，超过 64 KiB 后轮换，最多保留当前及上一份日志；不包含任务、课程或草稿正文。快照仍使用原来的格式和路径。

升级流程必须包括：

1. Windows 下从 Explorer 桌面环境执行备份、恢复和启动。核验实际快照文件的物理路径，区分原 AppData 与 MSIX 副本。导出完整原始逻辑数据，正常退出程序后完整备份用户目录，并记录程序版本及文件哈希。首次引入快照时，以已核验的升级前逻辑数据初始化安全快照。
2. 仅替换程序文件，禁止混合拷贝新旧 LevelDB 文件。
3. 用实际安装的程序重启，执行 `node scripts/verify-installed-data.cjs <程序路径> <升级前原始JSON> <验证结果JSON>`。任务、课程及其余原始键必须一致；只有已开启日期跟随的当天变化可例外。
4. 核验成功后正常启动给用户使用。失败则保留两份数据，停止进一步覆盖。旧的仅校验程序哈希的本机更新脚本已停用。

在 MSIX 应用的终端内可通过以下命令把验收交给 Explorer 执行。验收脚本检查快照及临时写入的物理路径，并核对实际安装进程读到的文件。`$verifiedFile` 只在核验成功时写出。

```powershell
& ./scripts/start-from-desktop.ps1 -Executable (Get-Command node).Source `
  -ArgumentList @((Join-Path (Get-Location) 'scripts/verify-installed-data.cjs'), $installedExe, $expectedFile, $verifiedFile) `
  -Background
```

验收结束后，同一脚本可用 `-Executable $installedExe` 启动正常面板。备份与验收均使用与桌面启动相同的文件视图。

回归入口：`npm test`、`npm run test:browser`、`npm run test:electron-storage`。最后一项只操作自身创建的隔离目录，可以通过 `TASKBOARD_SMOKE_APP` 指向待验收的 `app.asar`。

快照用于防数据库回退，不替代安装目录之外的升级备份；不要删除用户目录或 `data-safety/`。用户的逻辑导出、故障副本及备份禁止提交 Git。
