# Codex 性能修复报告（2026-10-14）

已修改源码，并在本机真实可见窗口中验证。主界面 CPU 从约 19%–20% 全机占用降到约 3.6%–4.5%，本应用 GPU 进程的 3D 引擎计数器从约 87%–89% 降到约 26.5%–28.5%。背景与角色持续运动，切到其他应用后也继续运行。

## 实测结果

同一个 Electron 进程、同一窗口，依次加载修改前完整页面 → 修改后完整页面 → 修改前 → 修改后。全程主界面，内容 1179×840 CSS px、DPR=2，开始和结束检查均可见且尺寸/页签一致。修改前文件来自本次修改前的逐字节备份；不是用修改后的页面加几个开关冒充原版。

| 阶段 | 全机 CPU | 单核等效 CPU | GPU 3D 中位数 | GPU 进程工作集 |
|---|---:|---:|---:|---:|
| release-before | 18.71% | 149.65% | 87.0% | 860 MB |
| release-after | 4.14% | 33.11% | 28.0% | 563 MB |
| release-before-return | 20.04% | 160.33% | 88.5% | 768 MB |
| release-after-return | 4.47% | 35.75% | 28.0% | 522 MB |

最后修正滚动条投影偏移、切页后的动画对象重建后，再重复切页验证：

| 阶段 | 全机 CPU | GPU 3D 中位数 | 小圆点动画 |
|---|---:|---:|---|
| verified-after-tabs-1 | 3.55% | 28.5% | 仅一个受控对象 |
| verified-after-tabs-2 | 4.45% | 26.5% | 仅一个受控对象 |

CPU 来自 psutil 的各 Electron 子进程累计 CPU 时间差，除以实测墙钟秒数；再除以 8 个逻辑核得到全机占比。GPU 3D 是 Windows `Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine` 中本应用 GPU PID 的 3D 引擎计数器，每组 6 次取中位数。GPU 进程 CPU、GPU 硬件利用率、GPU 进程工作集是三种不同指标；工作集也不是显存。不要将这里的硬件计数器直接与旧报告中的 GPU 进程 CPU 百分比比较。

## 原因与实际改动

这些是叠加成本，单独停一个装饰动画不足以证明其余结构没有问题：

1. **透视网格的大离屏表面。** 原网格宽 240vw，含透视、遮罩及裁切；高 DPI 下每帧合成成本很高。现在只在屏幕下半部 Canvas 内投影可见网格，缓存不变的纵线，逐帧合成移动横线。保留原来 430px 透视、70°倾角、64px 周期、2.6 秒速度及淡出。背景缓存上限 1600×800，文字和角色分辨率不变；背景细线会稍柔和。原 CSS 作为初始化/绘制失败时的回退。
2. **额外的持续出帧。** 极光和小圆点现在通过原 CSS Animation 的 `currentTime` 随已有角色循环统一按约 30fps 推进，缓动、方向和速度仍由原动画定义。切页后重新获取动画对象，不推进已取消对象，防止返回主界面后又出现独立的高刷新动画。
3. **SVG 圆环连续重绘。** 250ms 更新一次，却接续 300ms 的 stroke-dashoffset 过渡，使圆环一直逐帧重绘。移除该过渡并隔离圆环合成层；倒计时精度和刷新调度保持不变。
4. **实时特效与重复写入。** 去掉 94% 不透明卡片后收益很小的实时背景模糊；全屏扫描线改为视觉接近的浅透明纹理；文本和标题值不变时不重复写入 DOM。
5. **后台行为纠正。** 原性能开关的逻辑取反，实际默认启用了后台节流，与注释及交接要求不一致；现默认关闭节流，失焦不暂停动画，隐藏到托盘仍沿用已有逻辑。[Electron 运行时属性说明](https://www.electronjs.org/docs/latest/api/web-contents#contentsbackgroundthrottling)。

正式源码只改 `app.js`、`style.css`、`main.js`。保留了原先未提交的论文管理功能改动；没有升级 Electron、修改打包/更新配置、提交或推送。

## 验证

- 语法：`node --check app.js`、`node --check main.js`；差异格式：`git diff --check`，通过。
- 修改前回归失败：可见空闲 CPU 超预算；暂停时倒计时 750ms 内被重复写入 6 次。修改后 CPU 通过预算，重复写入为 0。
- GPU 预算：缓存前约 70%，不满足 40% 上限；最终约 27%–28%，通过。
- 失焦 2 秒仍绘制约 60 帧，极光 currentTime 正常推进；运行时 backgroundThrottling=false。
- 暂停/恢复、待办/日记/科研/设置/主界面切换、提醒打开/完成，全部通过。
- 独立代码审查发现并修复了切页后动画重建问题；新增检查先失败后通过。
- 原生 CSS 透视矩阵与 Canvas 投影对照，主窗口最大误差约 0.0016 CSS px；900×650、760×560 和副屏 125% 缩放均小于 0.02 CSS px。滚动条宽度和 CSS 视口小数尺寸已纳入计算。
- 主界面、各页签及提醒弹窗均已截图并人工复核。

## 复现与材料

使用本机已安装的 Python 和 psutil，无需安装依赖：

```powershell
& D:\CONDA\python.exe reports/performance_optimization/regression_check.py
& D:\CONDA\python.exe reports/performance_optimization/functional_check.py
& D:\CONDA\python.exe reports/performance_optimization/post_check.py
& D:\CONDA\python.exe reports/performance_optimization/resize_check.py
```

这些脚本启动独立临时 userData，结束后关闭自己的测试进程，不使用真实日记、待办或设置。测量时保持测试窗口可见；切页、隐藏或跨屏会影响数据，应以输出的 valid、view、viewEnd 为准。

- [最终 A-B-A-B 原始摘要](raw/codex-release-summary.json)
- [最终切页后验证及源码哈希](raw/codex-verified-summary.json)
- [功能验证结果](raw/codex-functional-checks.json)
- [多尺寸/跨屏结果](raw/codex-resize-checks.json)
- [最终主界面](screenshots/codex-verified-main.png)
- [各页与提醒检查图](screenshots/codex-functional-contact.jpg)
- [修改前源码备份](backups/codex-20261014-230537/)

GPU 目前仍承担持续动画的工作，数值没有降到零。本次验证覆盖本机主窗口与短时重复切换；没有做数小时稳定性测试、打包安装版测试或独立桌宠/日历性能复测。已安装 exe 不会自动包含源码修改。应先从托盘退出旧进程，再运行项目根目录的「启动测试版.cmd」查看修复；本次未发布安装包。

## 早期诊断数据的边界

旧诊断文档和探索性脚本保留作为历史证据。本报告仅引用上述明确通过可见性、尺寸和页签校验的数据；早期窗口被隐藏的低值、改变页签/DPI 的阶段及试验性驱动/Canvas CPU 路径，不用于最终结论。正式代码没有采用关闭硬件加速、强制 OpenGL、CPU 软件绘图、失焦停动画或降低前景分辨率。

动画现在虽显示为 paused，currentTime 仍由现有 30fps 循环推进，因此「CSS Animation.playState=paused」不能再作为完全静止的判断；需结合帧计数和 currentTime 差值。
