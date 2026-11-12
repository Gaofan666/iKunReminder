# iKunReminder 协作者开发指南

> 写给想参与这个项目的朋友。从「拿到仓库权限」到「你的功能被合并」的完整流程都在这里。
> 项目是 Electron 桌面应用（Node.js），主要代码在仓库根目录。

---

## 一、成为 GitHub 协作者

协作者可以直接推送分支、创建 PR，不需要 Fork（想用 Fork 方式也行，见文末备注）。

### 1. 准备工作
1. 注册/登录 [github.com](https://github.com)，并把你的 **GitHub 用户名** 发给仓库所有者（Gaofan666）。
2. 本机装好开发环境：
   - [Git](https://git-scm.com/downloads)（Windows 装 Git for Windows，自带 bash）
   - [Node.js](https://nodejs.org/) LTS 版本（项目用的是 Electron 44 内置 Node 24，开发机装 20+ 均可）

### 2. 所有者发出邀请（Gaofan666 操作）
打开仓库页面 → `Settings` → `Collaborators` → `Add people` → 输入用户名 → 发送邀请。

### 3. 接受邀请（你操作）
- 查收 GitHub 邮件，或打开 `https://github.com/Gaofan666/iKunReminder/invitations`；
- 点 **Accept invitation** —— 之后你就能直接向仓库推分支了。

### 4. 克隆仓库
```bash
git clone https://github.com/Gaofan666/iKunReminder.git
cd iKunReminder
npm install        # 装依赖（electron、electron-builder 等）
npm run start      # 跑起来看看，确认开发环境 OK
```

---

## 二、创建功能分支

**铁律：永远不要直接往 `main` 上写代码**。每个功能/修复开一个独立分支，改完发 PR。

```bash
# 1. 先同步主线，保证基于最新代码开发
git checkout main
git pull origin main

# 2. 从 main 拉出功能分支（命名建议见下）
git checkout -b fix/pet-always-on-top
# 或 git checkout -b feat/paper-search-filter
```

### 分支命名习惯（保持仓库整洁）
| 前缀 | 用途 | 示例 |
|---|---|---|
| `feat/` | 新功能 | `feat/paper-star-export` |
| `fix/` | 修 bug | `fix/pet-always-on-top` |
| `docs/` | 只改文档 | `docs/contributing-guide` |
| `chore/` | 构建/依赖/杂项 | `chore/bump-electron` |

---

## 三、改完代码后：提交 + 发合并请求（PR）

### 1. 本地提交
```bash
git status                  # 看改了哪些文件，确认没有改出无关的东西
git diff                    # 再过一眼改动内容
git add <具体文件>           # 用具体文件名，别习惯性 git add .
git commit -m "简明描述这次改动做了什么"
```

**Commit message 规范**（参照现有历史）：
- 一句话说清「干了什么」，中文即可；
- 尽量对应一个功能点/一个修复，不要一次塞十几个改动；
- 好例子：`修复弹窗输入时点击外部丢失输入`；坏例子：`更新了一堆东西`。

### 2. 推送分支到 GitHub
```bash
git push origin fix/pet-always-on-top
```

### 3. 创建 PR（Pull Request）
推送后 GitHub 会在命令行/页面给出链接，或手动打开：
`https://github.com/Gaofan666/iKunReminder/compare`
→ 选择你的分支 → 点 **Create pull request**。

PR 描述请写清楚三件事：
1. **改了什么**（功能点列表）；
2. **为什么改**（现象 / 用户反馈的 bug）；
3. **怎么验证**（你跑过哪些测试、复现步骤）。

### 4. 评审与合并
- 所有者会 Review 代码，有意见会在 PR 里留言，你补提交后 PR 自动更新（不用重新开）；
- 补提交就是继续在同一个分支上 commit + push：
  ```bash
  git add ... && git commit -m "按评审意见修改 xxx"
  git push origin fix/pet-always-on-top
  ```
- 评审通过后由所有者点 **Merge pull request** 合入 `main`，然后**删除分支**（PR 页面有按钮）。

### 5. 合并后同步本地
```bash
git checkout main
git pull origin main
git branch -d fix/pet-always-on-top     # 删掉本地已合并的分支
```

---

## 四、开发与自检（项目约定）

改完代码、发 PR 之前，请至少做这些：

```bash
node --check main.js          # 语法检查（改了哪个 js 就查哪个）
npm run start                 # 启动应用，手动过一遍你改的功能
```

改了核心逻辑的话，跑一下自检（主进程带诊断参数启动）：
```bash
npx electron . --diag-ppsmoke    # 投稿模块冒烟
npx electron . --diag-arxiv      # 科研模块自检
```

其他约定：
- **版本号**由所有者在 `package.json` 统一管理和发版，协作者的 PR 不改版本号；
- 新增 `.js` 文件要确认进了 `package.json` 的 `build.files` 白名单（否则安装版会缺文件）；
- 提交前确认没有把 `dist/`、`node_modules/` 之类的产物加进来（它们在 .gitignore 里）。

---

## 五、常见问题

- **推送被拒（non-fast-forward）**：先 `git pull --rebase origin main` 把远端新提交拉下来，再推。
- **想放弃这个分支**：`git checkout main && git branch -D fix/xxx`。
- **改错了一个文件想还原**：`git checkout -- 文件名`（未提交时）。
- **PR 冲突**：本地执行 `git checkout 你的分支 && git pull --rebase origin main`，解决冲突后 `git push`，PR 会自动更新。
- **不想要协作者权限、想用 Fork 方式**：Fork 仓库 → 在自己的 Fork 里建分支提交 → 回原仓库发 PR，其余流程相同。

---

有拿不准的地方，直接在 PR 或 Issue 里问，别自己猜着改。
欢迎加入！🎉
