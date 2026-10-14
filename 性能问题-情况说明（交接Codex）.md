# iKunReminder 主界面 CPU 占用问题 —— 情况说明（交接文档）

> 写给接手的人（Codex）。本文是**自包含**的：项目背景、测量装置、全部实测数据、代码位置、已试过并回退的做法、以及**下一步最该做的实验**都在这里。
> 所有数据都是本机实测；**测不出来的地方我明确标了"无效/未验证"**，请不要把它们当结论。
> 文档写于 2026-10-14 晚，仓库分支 `yl`，工作区**有未提交改动**（见第 9 节，别覆盖）。

---

## 0. 一句话结论（目前能确定的和不能确定的）

能确定：
- 主窗口**正常显示**时，整个应用的空闲 CPU 约 **150% ~ 176% 单核等效**（同一进程内反复测，三次回归一致，可信）。
- **把页面里所有动画都停掉 + 停掉页面 JS** 后，掉到 **0.7%**（同一进程内 A-B-A，可信）。
- **单独**关掉任何一个动画（网格/极光/极光模糊/扫描线/点/logo/舞台画布/卡片毛玻璃/混合模式）**几乎都没有效果**（都在噪声内）。
- **纯白页 Electron 对照应用**（同窗口尺寸、同样量法）= **0.2%**。
- 把网格动画从 `background-position` 改成**纯合成器 `transform`**（我已改）→ **没有任何收益**。
- 把窗口从 1179×840 缩到 590×420（面积 1/4）→ **没有变化**（该实验有一次未打印确认日志，见 4.4，建议重做）。

不能确定（**最重要的未解之谜**）：
- 为什么"**只要有任意一个动画在跑**"就值 ~150%，而"**全部停掉**"就是 0.7%，且**与窗口面积、与动画的具体实现方式都无关**。
- 因此**最该做的下一步实验**是：给那个"纯白页对照应用"**加一个最简单的 CSS 动画**，看它是否也跳到 ~150%（见第 8 节第 1 步）。
  - 若**是** → 问题在这台机器 / 驱动 / Electron 的"出帧"路径上，与本项目代码无关；
  - 若**不是** → 再回到本项目的具体构造继续二分。

---

## 1. 项目与技术栈 / 运行环境

| 项 | 值 |
| --- | --- |
| 项目 | 别感冒提醒器（iKunReminder），Electron 桌面应用，Windows |
| 框架 | Electron **44.3.0**（Chromium），原生 HTML/CSS/JS，无前端框架 |
| 主窗口 | **1179×840 CSS px，DPR = 2 → 内容物理尺寸 2360×1670 ≈ 4.0 Mpx**（`--diag` 自检实测，见 trace 的 `contentPhysical`） |
| 窗口属性 | `transparent: false`、`backgroundColor: '#E9F4FA'`、`backgroundThrottling: false` |
| 其他窗口 | 桌面宠物（独立小窗）、桌面日历挂件、气泡提示（都是独立 `BrowserWindow`） |
| 页面结构 | 装饰层是 body 级背景（切页签后一直在）；内容在一个 `#view{will-change:transform}` 的等比缩放层里 |
| 本机环境 | Windows 10.0.19045，**i5-1135G7（核显 Iris Xe）**，8 逻辑核，主屏 1440×900 + 副屏 2048×1152 |
| GPU 状态 | `app.getGPUFeatureStatus()`：`gpu_compositing: "enabled"`、`rasterization: "enabled"`、`multiple_raster_threads: "enabled_on"`、`opengl: "enabled_on"`、`direct_rendering_display_compositor: "disabled_off_ok"` → **不是软件合成** |

**单位约定**：本文 CPU 一律为**单核等效百分比**（`100 × ΔCPU秒 / Δ墙钟秒`，可超过 100）。
注意 `app.getAppMetrics()` 返回的 `cpu.percentCPUUsage` 是**占全机 8 核**的比例，**换算单核等效要 ×8**（这一点曾经把我坑过，见 4.3）。

---

## 2. 问题现象

- 用户报告：空闲时（不操作、主界面开着）任务管理器里 CPU 长期偏高，偶尔 40%~140%，GPU 进程也常有 10~25%。
- 主窗口 Renderer 内存 700~850 MB；**GPU 进程内存约 919 MB**（偏高，可疑）。
- 与当前在哪个功能页签基本无关（装饰层是全局背景）。

**⚠️ 最大混淆变量（务必先读）**：窗口**被遮挡/不可见**时 Chromium **不出帧**，此时测出来只有 1~2%；窗口**可见**时才是真实负载（150%+）。
我早期有几组数据是 0%/0.8%/1.8%，就是踩了这个；**同一份代码能差 80 倍**。
所以：**跨轮次比较单次测量结果不可信**，必须用同一进程内的前后对照（见 3.4）。

---

## 3. 我已经建好的测量装置（可直接复用，别重造）

### 3.1 启动参数（都在 `main.js` 里实现，不带参数时零执行）

| 参数 | 作用 |
| --- | --- |
| `--perf-sample` | 打开采样器：每秒把 `app.getAppMetrics()` 的每个进程写一行 CSV |
| `--perf-label=名字` | CSV 文件名里的标签 |
| `--perf-seconds=30` | 采样多少秒后自动停止写（进程仍在运行） |
| `--perf-ablate=模式` | 给 `document.body` 加 `ablate-<模式>` 类（消融，见 3.3） |
| `--perf-win=590x420` | 采样中途把主窗口改成这个尺寸 |
| `--perf-win-delay=12` | 第几秒改（默认 12） |
| `--perf-throttle` | **临时 A/B 开关**：打开主窗口的正常 Chromium 节流（默认仍是 `backgroundThrottling:false`） |

### 3.2 采样 CSV

写到 `reports/performance_optimization/raw/appmetrics-<label>-<时间>.csv`：

```
label,iso,type,pid,percentCPU,idleWakeupsPerSecond,workingSetMB,visible/focused/minimized
```

- 开头有一行 `# visible=1,focused=1,minimized=0`，**每行采样也都带窗口状态**（这是判断"这次测量有没有被遮挡污染"的唯一依据）。
- `type` 字段区分 `Browser`(主进程) / `Tab`(渲染进程) / `GPU` / `Utility` —— **GPU 不会被误算进 Renderer**。
- `HEARTBEAT` 行是采样回调的存活证明；`ERROR-*` 行是采样内部异常。

### 3.3 消融模式（`--perf-ablate=xxx` 或运行时给 body 加类，规则在 `style.css` 末尾）

| 模式 | 作用 |
| --- | --- |
| `grid-motion` / `grid-hidden` | 暂停 / 隐藏网格（已跟随 `::before`） |
| `aurora-motion` / `aurora-hidden` / `aurora-nofilter` | 暂停 / 隐藏 / 去模糊 极光 |
| `minor-motion` | 暂停 `.dot` / `.logo` |
| `all-motion` | 暂停全部装饰动画 |
| `canvas-hidden` | 隐藏角色舞台 |
| `minimal` | 隐藏全部装饰 |
| `nobackdrop` | 关掉卡片的 `backdrop-filter` |
| `noblend` / `noscanlines` | 扫描线关混合模式 / 隐藏扫描线 |
| `noboth` | 上面两个一起 |
| `nothing` | 暂停 4 个装饰动画 + 隐藏舞台（配合外部停 JS） |
| `js-off` / `js-off-minimal` | **真正停掉页面 JS**：清掉所有小整数 id 的 interval/timeout + 换掉 rAF |

> ⚠️ 覆盖 `window.setInterval` **不能**停掉已存在的定时器（只影响新调用）—— 早期一次实验就是这么失效的。

### 3.4 ★ 可信做法：同一进程内 A-B-A（**只用这个下结论**）

组间单次跑会被"窗口是否可见/是否在漂移"污染。可信做法是在**同一个进程**里，用调试协议**实时增删**消融类（CSS 立即生效，不需要重启），并让基线**回归一次**：

```powershell
# 1) 启动（带调试端口 + 临时存档，不碰用户数据）
Start-Process .\node_modules\electron\dist\electron.exe `
  -ArgumentList 'E:\python\Reminder',"--user-data-dir=$env:TEMP\kunkun-ab","--remote-debugging-port=9470"

# 2) 从 http://127.0.0.1:9470/json 拿 index.html 的 webSocketDebuggerUrl，
#    用 ClientWebSocket 发 Runtime.evaluate：
#    a) 量 14 秒累计 CPU（=单核等效）
#    b) document.body.classList.add('ablate-XXX'); 再量 14 秒
#    c) document.body.classList.remove('ablate-XXX'); 再量 14 秒  ← 必须回到基线，否则该轮作废
```

**判定标准**：基线 → 干预 → 基线，如果两次基线接近（差 <5%）且干预明显不同，才算数。

---

## 4. 实测数据

### 4.1 可信的逐项归属（同一进程 A-B-A，窗口全程 `visible=1`）

```
A 原样                        163.9%
仅暂停网格动画                  145.4%      ← 省 18.5 点（唯一有单项效果的）
  ↳ 恢复                       167.2%
仅隐藏极光                     170.4%      ← 噪声内
  ↳ 恢复                       161.7%
仅去极光模糊                    176.1%      ← 噪声内
  ↳ 恢复                       173.4%
仅隐藏扫描线                    180.6%      ← 噪声内
  ↳ 恢复                       177.2%
仅暂停 .dot/.logo              179.0%      ← 噪声内
  ↳ 恢复                       175.9%
仅隐藏舞台画布                  174.8%      ← 噪声内
  ↳ 恢复                       175.5%
停掉页面 JS（定时器 + rAF）      143.5%      ← 省 20.4 点
```

⚠️ 注意：**基线在这一轮里从 163.9 缓慢爬到约 176**（+12 点）→ 各次"恢复"值并不相同，
所以**小效应（<20 点）不能靠这一轮判定**；只有"网格"和"停 JS"这两个方向性一致、值得继续查。

### 4.2 卡片毛玻璃 / 混合模式（同一进程 A-B-A，状态全程一致）

```
A 原样            163.7%
关卡片 backdrop-filter 163.8%    ← 无变化 ✗（"backdrop-filter 是元凶"的假设被否定）
A2 恢复          162.1%         ← 回到基线，说明本轮可信
关扫描线 mix-blend-mode 179.4%    ← 反而更高（噪声）
H 两个都关        138.4%
A3 恢复          163.6%         ← 再次回到基线
```

### 4.3 无效数据（**别用**）

| 数据 | 为什么无效 |
| --- | --- |
| 早期 7 组"消融无差异"（170~183%） | 采样器与消融驱动当时根本没运行（三个 bug：`--perf-*` 未进 DIAG 解析 → `DIAG=null`；采样块里 `path.basename` 写成 `fs.basename` 抛异常；`DIAG` 为 null 时 `if (DIAG.pet)` 抛异常中断整块）→ 那几组其实是同一个基线 |
| A~M 矩阵里的 `C_nobackdrop 0.8%` / `I_allmotion 0%` / `J_gridhide 0%` / `L_auroranoblur 0%` | 这几轮渲染进程也是 **0%** = "什么都没干"的空闲态（窗口被遮挡）→ 状态污染 |
| 一次 2×2 分解的基线 **1.8%** | 同上 |

### 4.4 对照与规模实验

| 实验 | 结果 | 说明 |
| --- | --- | --- |
| **纯白页 Electron 对照**（同 1179×840 窗口，无任何动画） | **0.2%** | 说明不是"机器/窗口本身"的问题，也不是驱动基线 |
| 窗口 1179×840 (4.0 Mpx) → 590×420 (1.0 Mpx) | 149.6% → **148.1%** | **与窗口面积无关**。⚠️ 这一轮 `[perf-win]` 日志没打出来，**建议重做确认** |
| `--perf-throttle`（打开主窗口节流）A/B | 129.6% vs 127.2% | `backgroundThrottling` **不是**原因 |
| GPU / 渲染 / 主进程 拆分 | GPU ≈ **134~149%**，渲染 ≈ 22~25%，主进程 ≈ 0.8% | 开销在 **GPU 进程** |
| 全静止（动画全 paused + JS 停） | **0.7%** | 同一进程 A-B-A，已就地验证"正在运行的动画 = []" |

### 4.5 两个附带可疑点

1. **GPU 进程内存约 919 MB**（对照的纯白页没有）—— 可能是图层/表面累积；
2. **基线在 2 分钟内从 163.9 爬到 ~176** —— 像一个缓慢累积的开销（泄漏？）。

---

## 5. 我目前的判断（供参考，不是结论）

把所有数据放一起，最贴合的解释是：

> **在这台机器上，"这个窗口只要在持续出帧"，每帧的固定成本就异常高（≈150% 单核），
> 而这个成本既不随窗口像素量变化，也不随动画的实现方式（重绘型 `background-position` vs 纯合成型 `transform`）变化。**

这解释了三件看似矛盾的事：
- 单独关一个动画没用（其余动画仍让它出帧）；
- 全关掉 → 不再出帧 → 0.7%；
- 纯白页（从不出帧）→ 0.2%。

但它**非常不正常**：现代核显合成 4 Mpx、60Hz 的窗口通常只占个位数百分比。
所以**更可能的真相是"这条出帧路径在这台机器上退化成了很贵的东西"**（某种软件回退、驱动问题、或 Electron 在这个组合下的已知坑）。
**因此第 8 节第 1 步的那个"对照应用 + 一个动画"实验，比在本项目里继续改 CSS 更重要。**

---

## 6. 代码位置清单

| # | 位置 | 现状 | 备注 |
| --- | --- | --- | --- |
| 1 | `style.css` 约 **42~65 行** `.grid-floor` | **我改过了**：外层保留 `position/尺寸/transform:translateX(-50%) perspective(430px) rotateX(70deg)/mask-image/overflow:hidden`，图案移到 `.grid-floor::before`，动画改成 `transform: translate3d(0,0,0) → translate3d(0,64px,0)`（2.6s 循环，64px = 图案周期，无缝） | **实测无收益**；可保留，也可按下面第 7 节的原文回滚 |
| 2 | `style.css` 约 **56~64 行** `.aurora` | 原样：两个 `radial-gradient` + `filter:blur(10px)` + `transform` 无限动画（14s） | 单项消融无效 |
| 3 | `style.css` 约 **66~70 行** `.scanlines` | 原样：`position:fixed;inset:0;z-index:60` + `mix-blend-mode:overlay` | 单项消融无效 |
| 4 | `style.css` 约 **712~718 行** `.card` | 原样：`background:var(--panel)` + `backdrop-filter:blur(9px)` | 关掉它**无变化**（已实测） |
| 5 | `style.css` 约 **692~699 行** `#view` | 原样：`width:1180px` + `transform-origin:top left` + `will-change:transform`（等比缩放容器） | 所有卡片都在这个缩放层里 |
| 6 | `style.css` 约 **36~39 行** | `body.anim-off *{animation-play-state:paused !important}` | 已经有了（收托盘时用）；注意我删掉了自己后来加的重复规则 |
| 7 | `pet-draw.js` **164 行起** `class Kunkun` / **206** `frame()` | `frame()` 每帧 `ctx.clearRect(0,0,w,h)`（后备缓冲约 1013×870） | 任务书点名的问题之一 |
| 8 | `pet-draw.js` **254** `drawGround` / **380** | **每帧新建** `createRadialGradient` / `createLinearGradient` | 任务书点名的问题之一；可用"radius=1 的渐变 + 缩放"等价替代 |
| 9 | `app.js` **627/628** | `const stage = new Kunkun($('#stage'))` / `alertStage = new Kunkun($('#alertStage'), {fit:300})` | 第二个实例只在提醒弹窗可见时绘制 |
| 10 | `app.js` 约 **5849~5880** | `function loop(now)` + `const FRAME_MS = 1000/30`（rAF 限帧 30fps）+ `stage.frame(now)`；另有 `tickTimer = setInterval(tick, ms)`（前台 250ms / 收托盘 1000ms） | 停掉它们省 ~20 点 |
| 11 | `main.js` **约 645 行** | 主窗口 `backgroundThrottling: false`（我用 `--perf-throttle` 做了临时 A/B，默认行为不变） | 宠物 6689 / 日历 7041 / 气泡 7871 也是 false |
| 12 | `main.js` **约 46 行** | `const PERF = ...`（性能模式开关，与自检 `DIAG` 解耦） | 不带 `--perf-sample` 时全为 false |
| 13 | `main.js` 约 **1228 行起** | 性能采样器（`app.getAppMetrics()` → CSV）+ 消融驱动 + `--perf-win` 钩子 | 只在 `--perf-sample` 时执行 |

---

## 7. 已经试过并**回退**的做法（别重复）

| 尝试 | 结果 |
| --- | --- |
| 用自排队 `setTimeout` 替换 `requestAnimationFrame` | 不可复现的收益 + 动画肉眼变卡 → **已回退** |
| 让极光停止运动 | 无收益 → 已回退 |
| 给装饰层加 `transform: translateZ(0)` + `will-change: transform` | **覆盖掉网格的 `rotateX(70deg)`，倾斜消失（视觉回归）** → 已回退。**教训：`.grid-floor` 外层绝不能加会覆盖 transform 的属性** |
| 失焦（blur）就降帧/停动画的省电模式 | 用户明确不要：切到别的应用动画必须继续 → 已回退 |
| 主窗口去掉 `backgroundThrottling:false` | 实测无差异，且用户要求保留 → 已恢复 |
| 我加的重复 `body.anim-off .xxx{animation:none}` 规则 | 与第 36~39 行的全局规则重复 → 已删除 |
| 早期一次"关 CSS 动画无效"的结论 | **作废**：真正原因是消融类根本没被加上（驱动 bug），不是 CSS 规则失效 |

**网格的原始实现**（若要回滚第 1 项，用这段替换回 `style.css` 第 42~65 行）：

```css
.grid-floor{
  position:fixed;left:50%;bottom:-12vh;width:240vw;height:62vh;z-index:0;
  transform:translateX(-50%) perspective(430px) rotateX(70deg);
  background-image:
    linear-gradient(rgba(74,155,212,.20) 1px, transparent 1px),
    linear-gradient(90deg, rgba(111,181,107,.20) 1px, transparent 1px);
  background-size:64px 64px, 64px 64px;
  -webkit-mask-image:linear-gradient(to top, rgba(0,0,0,.95), transparent 88%);
  mask-image:linear-gradient(to top, rgba(0,0,0,.95), transparent 88%);
  animation:gridmove 2.6s linear infinite;
  pointer-events:none;
}
@keyframes gridmove{ to{ background-position:0 64px, 0 0; } }
```

---

## 8. 建议的执行顺序

1. **★ 先做这个（最重要，成本最低）**：在那个"纯白页 Electron 对照应用"里加**一个最简单的 CSS 动画**（例如一个 200×200 的 div 做 `transform: translateX` 无限循环），用同一套装置测它的 CPU。
   - 若也到 ~150% → **问题在机器/驱动/Electron 的出帧路径**，本项目代码无需大改；应把这个结论反馈给用户，并考虑 `app.disableHardwareAcceleration()` 之类的对照、或换 Electron 版本/驱动验证；
   - 若仍在个位数 → 回到本项目继续二分。
2. 用**同进程 A-B-A**（3.4）重做"窗口面积"实验（`--perf-win`），确认【每帧成本与面积无关】这个结论（该轮日志没打印，需确认 `win.setSize` 真的生效）。
3. 用 **Chromium Performance Trace**（`--remote-debugging-port` + DevTools Performance / `contentTracing`）录 10 秒可见状态，看 `RasterTask` / `Paint` / `CompositeLayers` 的**频率与耗时**，以及有没有 **Software** 前缀的事件。这是唯一能直接回答"每帧到底在干什么"的手段。
4. 如果确认是"出帧本身贵"，再考虑**结构性**方案（都需要实测验证，别直接上）：
   - 装饰层（网格/极光）用**低分辨率源 + 放大**（它们本身是柔和图案），减少每帧像素量；
   - 把装饰层拆到**独立的 `BrowserWindow`**（背景窗）里 —— 小窗口 + 独立合成，参考"桌面宠物很便宜"这一现象；
   - 评估 `--disable-gpu-compositing` / `--disable-frame-rate-limit` 等开关的对照结果（**仅作诊断**）。
5. 只有在第 1~3 步明确了归属之后，再回到 `pet-draw.js` 的渐变缓存 / `clearRect` 范围、以及 `app.js` 的 250ms `tick` 做常规优化（这两处按任务书本来就该优化，预计能省 20~40 点）。

---

## 9. 交付物与仓库状态

### 9.1 报告与数据（都在 `reports/performance_optimization/`）

- `PERFORMANCE_DIAGNOSIS.md` —— 诊断报告（含 8 节：渲染清单、测量方法、**已作废数据的更正**、有效数据、突破结论、桌宠分析）
- `PERF_VALIDATION.md` —— 以后怎么跑测量/消融/trace/视觉回归
- `raw/` —— **30+ 个原始 CSV**（`appmetrics-*.csv` 每次采样一份）+ 3 份汇总（`ablation-summary.csv` / `ablation-valid.csv` / `animation-attribution.csv` / `matrix-A-I.csv`）
- `screenshots/before-main.png`、`screenshots/after-main.png` —— 网格改造前/后（⚠️ 两张的动画相位不同，**不能直接做像素差**；改后截图的 `matrix3d(...0.34202,0.939693...)` 证明**倾斜仍在**）

### 9.2 工作区未提交改动（**请勿直接覆盖**）

`git status`（相对 `157cdef v4.6.5`）：

| 文件 | 内容 |
| --- | --- |
| `README.md` / `index.html` / `app.js` / `papers.js` | **功能需求改动**（与性能无关）：我的投稿→我的论文；我的角色可自填；拒稿独立成状态+原因；新增「编辑初审」「等待编辑决定」；「其他进展」可自定义说明；状态名不再串台；`resolveDeadline` 修正 |
| `style.css` | ① 网格改造（第 6 节 #1，**可回滚**）② 末尾追加的消融类（**测试用**，不带 `ablate-*` 类时零影响） |
| `main.js` | ① 性能测试代码：`const PERF`、DIAG 替身、采样器块、`--perf-win` 钩子、`if (DIAG || PERF)`、`if (PERF) {}` 退出守卫、`--perf-throttle` 临时开关（**默认行为不变**）；② 功能需求改动 |
| `reports/` | 新增目录（未跟踪） |

**要求**：正式运行路径不得依赖任何 `--perf-*` 参数；若最终不需要这些测试代码，请把 `main.js` 里第 6 节 #12/#13 那两处删掉（都不带参数时本来就不执行）。

### 9.3 不要做的事

- 不要 `git checkout .` / 不要 `git stash` 丢弃上面的功能改动；
- 不要改用户数据、日记、待办、设置；
- 不要升级 Electron、不要动打包/自动更新配置；
- **不要擅自 push**（用户要求推送前必须问他）。

---

## 10. 一键复现（最短路径）

```powershell
cd E:\python\Reminder
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# ① 采一次基线（含窗口状态列）
Start-Process .\node_modules\electron\dist\electron.exe `
  -ArgumentList 'E:\python\Reminder','--perf-sample','--perf-label=baseline','--perf-seconds=30'
# 30 秒后看 reports\performance_optimization\raw\appmetrics-baseline-*.csv
#   → 若头部是 visible=0，这一轮作废（窗口被遮挡）

# ② 同进程 A-B-A（唯一可信的归属手段）：见第 3.4 节的调试协议写法
# ③ 想要 trace：加 --remote-debugging-port=9333，用 Chrome 打开 chrome://inspect 连上，Performance 录 10 秒
```

---

## 附：我踩过的坑（避免重复）

1. `app.getAppMetrics()` 的 `percentCPUUsage` 是**全机 8 核**比例，**单核等效要 ×8**；
2. 采样式测量**必须记录窗口 visible/focused**，否则同代码能差 80 倍；
3. PowerShell 里做字符串替换：**只能用唯一字面量或行定位 + 守卫**，不要用 `Substring`/`LastIndexOf` 拼（我因此损坏过 `app.js` 两次、`main.js` 一次）；
4. PowerShell 双引号串里**不能出现中文引号** `“ ”`（会解析报错）；
5. 批量替换**必须带函数上下文**：我曾用整文件 `.Replace` 把一句"拒稿原因"同时插进了 `evSummary` 和 `resolveDeadline`；
6. `--diag-*` 自检模式**跑完会自动退出**（`app.exit`），性能采样必须与它解耦（否则采样器根本来不及跑）；
7. `--diag-win` 那类自检模块**会还原窗口尺寸**，不能用它做"窗口大小"对照。
