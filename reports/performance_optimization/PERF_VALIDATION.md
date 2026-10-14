> 2026-10-14 Codex 更新：本文包含早期及已作废的诊断结论。最终修复、有效数据、测试入口和适用边界见 [CODEX_FIX_REPORT.md](CODEX_FIX_REPORT.md)。原文保留供追溯。

# PERF_VALIDATION —— 性能测试怎么跑（可重复执行）

> 目的：让以后每一版都能用同一套方法量出"是否退化/是否改进"，并避免重犯早期的测量错误。

## 0. 一句话结论（目前）

本机实测：**主窗口空闲 ~170~180% 单核等效**，而且**把 CSS 动画、极光模糊、页面 JS 全部关掉后依然不变**。
→ 所以"关动画/降帧率"这条路已经被证伪；下一步必须查**窗口合成层**（`app.getGPUFeatureStatus()` 是否为软件合成）。详见 `PERFORMANCE_DIAGNOSIS.md`。

## 1. 固定测试条件（每次都要记录）

| 项 | 本次值 | 怎么取 |
| --- | --- | --- |
| Electron | 44.3.0 | `node -p "require('./node_modules/electron/package.json').version"` |
| Windows | 10.0.19045 | `[Environment]::OSVersion` |
| CPU | i5-1135G7（核显 Iris Xe） | `Get-CimInstance Win32_Processor` |
| 逻辑核 | 8 | `[Environment]::ProcessorCount` |
| 屏幕 / DPR / 窗口 | 1440×900 主 + 2048×1152 副；DPR=2；1179×840 CSS | 见 `PERFORMANCE_DIAGNOSIS.md` 第二节 |
| 其他窗口 | 桌面宠物/日历/气泡是否开启 | 设置页确认并记录 |
| DevTools | **关闭**（录制只用于定位，不用于定量） | — |

## 2. 跑一次 CPU 采样

```powershell
cd E:\python\Reminder
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# 预热 10 秒后开始采样，采样 25 秒
Start-Process .\node_modules\electron\dist\electron.exe `
  -ArgumentList 'E:\python\Reminder','--perf-sample','--perf-label=baseline','--perf-seconds=25'
```

- 应用内每秒写一行到 `reports/performance_optimization/raw/appmetrics-<label>-<时间>.csv`
  （`type` 字段区分 Browser / Tab / GPU / Utility —— **GPU 不会被算进 Renderer**）。
- 应用外累计 CPU 口径（本报告数字的来源）：

```powershell
$snap=@{}; Get-Process electron | ForEach-Object { $snap[$_.Id]=$_.CPU }
Start-Sleep -Seconds 15
$sum=0.0; Get-Process electron | ForEach-Object { if($snap.ContainsKey($_.Id)){ $sum += ($_.CPU-$snap[$_.Id]) } }
'{0}% 单核等效' -f [Math]::Round($sum/15.0*100,1)
```

> `单核等效% = 100 × ΔCPU秒 / Δ墙钟秒`；Windows 任务管理器显示的是"占全机(8 核)比例"，本口径 ÷8 才与它可比。

## 3. 跑消融对比

在采样参数后加 `--perf-ablate=<模式>`（模式见下）。建议**交错顺序** A-B-A-B 以抵消温度/顺序偏差，每组重复 ≥3 次取中位数。

| 模式 | 回答的问题 |
| --- | --- |
| `grid-motion` / `aurora-motion` / `all-motion` | **暂停运动**能省多少（元素与静态外观保留） |
| `grid-hidden` / `aurora-hidden` / `minimal` | **隐藏元素**能省多少（同时去掉绘制与合成） |
| `aurora-nofilter` | **只去滤镜**能省多少（保留运动与形状） |
| `minor-motion` | 小动画（点/logo）的成本 |
| `canvas-hidden` | 隐藏舞台的成本 |
| `js-off` / `js-off-minimal` | **真正停掉页面 JS 循环**的成本 |

⚠️ 三种操作（暂停运动 / 隐藏元素 / 去滤镜）回答的是不同问题，**不要混为一谈**。
⚠️ 不要用 `@media (prefers-reduced-motion)` 来做测试开关：早期一条写错位置的规则让整个实验失效过。
⚠️ 覆盖 `window.setInterval` **不能**停掉已经存在的定时器（只影响新调用）—— 这也是早期一次实验结论失真的原因；`js-off` 模式是用"清掉所有小整数 id"来真正停掉的。

## 4. 取 trace（下一步要做的）

1. 启动时加 `--remote-debugging-port=9333`，用 Chrome 打开 `chrome://inspect` 连上主窗口；
2. Performance 面板录制 10 秒（只勾 **Screenshots 关闭**、保留 Paint/Compositing/GPU 轨道）；
3. 重点看：`RasterTask`、`Paint`、`CompositeLayers`、是否有 **`Software` 前缀**的合成事件、以及帧间隔是否规律；
4. 把 trace 存到 `reports/performance_optimization/raw/`（体积大就只留 10 秒片段）。

**同时务必读取**（本轮尚未执行，是定位"合成层"问题的关键一步）：

```js
// 在主进程里（例如采样器启动时打印一次）
console.log(JSON.stringify(require('electron').app.getGPUFeatureStatus(), null, 1));
```

关注 `gpu_compositing` / `rasterization` / `video_decode` 是否为 `disabled_software` —— 若为软件合成，那"每帧合成 4 Mpx"就是 CPU 开销的来源，处理方向会完全不同（降窗口/图层像素量、减少合成层数、而不是关动画）。

## 5. 视觉回归怎么验

1. 修改前后各截一套图（同一窗口尺寸、DPR、页签、缩放）：
   `--diag-shot=<路径>` 或 DevTools 截图；分别覆盖：主界面、待办、日记、科研、设置；
2. 动态内容要**固定动画相位**再比：可用 DevTools 的 Animations 面板暂停，或临时把 `animation-delay` 设为负值对齐相位；
3. 重点检查：网格**倾斜/透视**是否保留、滚动方向、周期交界处是否跳变、线条粗细是否变化、极光颜色与模糊边缘、图层遮挡关系、不同 DPI 下的表现；
4. 不要只看整图相似度（大面积背景会掩盖小范围失真），要**分区对比 + 人眼确认关键区域**。

## 6. 如何判断"新代码是否造成性能退化"

1. 与上一版**同条件**各跑 3 次 `baseline`（不带 `--perf-ablate`）；
2. 取中位数：若中位数上升超过 **15%**，或出现"某一进程类型显著变高"，判为**疑似退化**，再取 trace 定位；
3. 同时看 **GPU 进程**：Renderer 降了但 GPU 升了，不算成功；
4. 顺带记录内存（CSV 里 `workingSetMB`），大图层缓存变多也要警惕。

## 7. 测试代码的边界（已遵守）

- 性能相关代码只在带 `--perf-*` 时运行，**正式启动零影响**；
- 消融 CSS 只在 `body` 带 `ablate-*` 类时生效；
- 测试使用独立临时 userData，**不读写用户真实数据/日记/待办/设置**；
- 新增文件：`reports/performance_optimization/**`；修改：`main.js`（开关与采样器）、`style.css`（消融规则，末尾追加）。
