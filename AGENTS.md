# AGENTS.md —— 给 AI 助手 / 新协作者的「先读这个」

> 这个文件故意写得很短：它只负责**指路**和**列待办**。细节都在 README 和代码注释里。
> 如果你（人或 AI）要审计或改这个仓库，请先看最后一节「📌 待办」。

## 这是个什么项目

Electron 桌面提醒器（iKunReminder）。纯 JS，**运行时只依赖 `electron-updater`**，没有框架、没有构建步骤。

| 文件 | 干什么 |
| --- | --- |
| `main.js` | 主进程：窗口 / 托盘 / 多屏 DPI 适配 / 自动更新 / **全部自检（`--diag-*`）** |
| `app.js` | 主界面渲染逻辑（逾期·延期计数、分类、折叠栏、日历推送都在这里） |
| `cal.js` `pet.js` `bubble.js` | 桌面日历 / 桌宠 / 气泡三个独立小窗 |
| `ui-scale.js` | 多屏 DPI 适配因子（主进程与页面共用） |
| `index.html` `style.css` | 主界面结构 / 样式（顶栏尺寸挂 `--tb-k`，按可用宽自适应） |

## 本仓库的几条约定（改代码前请遵守）

1. **改完必须跑相关自检**：`node_modules\electron\dist\electron.exe . --diag-<名字>`，
   自检日志在 `.diag\trace.log`（`.diag/` 已在 .gitignore 里）。断言都写在 `main.js` 里，照真实界面点一遍。
   常用：`--diag-memo` `--diag-cal` `--diag-cat` `--diag-count` `--diag-dpi` `--diag-why` `--diag-late`
   ⚠️ 跑之前先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`，否则 Electron 会被当成纯 Node 启动、主进程直接崩。
2. **README 的更新日志只写重要更新 / 修复**（一两行说清「是什么、为什么」），
   细节写进代码注释和提交信息 —— 别在 README 里堆长篇。
3. **数据全在本机**：`localStorage` 的 `kunkun.*.v1`（leveldb 在 `%APPDATA%\iKunReminder\Local Storage\leveldb`）。
   要改动用户数据，先备份那个目录。
4. **单实例锁**：调试时别同时开「安装版」和 `启动测试版.cmd`，两者共用同一份用户数据。

## 📌 待办（TODO）

- **更新完成后弹一个「本版更新要点」的窗**（还没做；README 末尾「待办（TODO）」一节有同一份说明）
  - 判断方式：把「上次运行时的版本号」存进 `localStorage`，启动时和当前版本比 —— 不一样就弹一次。
  - **要点文字按版本写在仓库里**（一张小表，放在 `app.js` 或独立文件里），
    **不要**依赖 GitHub release 的正文 —— 那需要仓库 owner 每次手写，写在仓库里则跟着代码进 PR、不用联网。
  - 顺手在「设置 → 软件更新」里给一个「本版更新要点」的回看入口。
  - 落地位置：主进程的更新逻辑（`main.js` 里 `updateInfo` 与更新状态推送那一段）
    + 设置页那块（`app.js` 的 `renderUpdate`）。两处都留了 `📌 TODO` 注释锚点。
  - 自检想法：模拟版本变化 → 断言弹窗出现、文案对、只弹一次。
  - 注意：这个改动**不影响**「用户能不能收到更新」—— 那取决于仓库 owner 是否在 GitHub
    发了带安装包资产的 Release（`electron-updater` 的 publish 指向 `Gaofan666/iKunReminder`）。
