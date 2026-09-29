<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# 极端场景压力测试：巨大 Turn、长分支与远距离阅读位置恢复

日期：2026-09-29。产品版本：`5017c7534780f21fef65ab13a93c92c95ce16a3e`，PR #5712。

**测试定位：人工合成的极端场景和规模边界压力测试，包含同版本的根会话对照组。数据用于描述指定压力下的成本，不代表日常使用的性能或真实用户场景分布，也不能单独决定优化优先级。**

单 Turn 内 1,000 次工具调用、单条 4 MiB assistant 正文均为人为构造，未验证真实使用中的发生频率，也未验证普通模型输出能否自然形成后者。Turn 指一轮任务，通常从用户提出请求到这轮执行结束；一个会话可以包含很多 Turn。长会话分支和恢复旧位置本身是正常操作，但本轮历史长度、工具密度以及恢复到第一 Turn 的距离是人为选定的压力条件，其代表性尚未通过真实使用分布验证。

先前这些边界主要有正确性覆盖。本轮补充了压力条件下的性能数据：巨大单 Turn 和远距离恢复出现秒级等待；根会话对照组停在最近历史时，100 到 1,000 Turn 的切回中位数基本不变。这些结果保留为边界回归证据。本轮只测量，不增加产品机制。

## 条件与口径

- Apple M2 Pro、16 GiB、macOS Darwin 25.6.0 arm64、Electron 43.4.1。重新构建的 production packaged app，真实本地 isolated Host；会话均已终止，无真实模型调用。
- 每个成功场景使用独立的新 fixture 副本、一个新的 app/Host 进程；随后测量同进程下 5 次离开再切回。源会话为 2 Turn × 1 tool。切走停留 500 ms，切回显示后继续观察 1.5 s。不是进程冷启动或 Host ready 基准。
- 主时间从真实 Renderer `pointerdown` 开始，到目标 Turn 已挂载、`data-placed` 成立、透明度至少 0.99 后两个 RAF。随后断言目标 Turn 与视口相交。它包含动画和自动化观察开销，不是物理屏幕呈现时间或页面完全稳定时间。
- 首次 ready 与恢复目标范围的最后一次 ready 分开。恢复旧位置时，最近历史可以先 ready，但目标位置还不能显示。二者不能替代。
- Host CPU 为切回前到上述可见帧后的进程累计 CPU 增量；完整周期及显示后 1.5 s 的增量另列。RSS 每 200 ms 采样，覆盖完整切换周期与观察期，不是内核保证的峰值。
- 计时期间不运行 CPU profiler、构建或 fixture 生成；OS 缓存未清空。每组只有 5 次，报告中位数和最大值，不宣称 p95 或尾延迟保证。试跑不纳入统计，首个正式返回和慢样本均保留。

## 切回结果

成功场景共 55 次返回；每行 5 次。时间为毫秒，CPU 为 CPU 秒，RSS 为 MiB；除最大值列外均为中位数。页数和字节数在各组五次之间相同。

| 目标场景 | 可见时间 p50 / 最大值 | 历史页数 | Renderer MiB | 切回 Host CPU | 完整周期 Host CPU | Host 采样峰值 RSS |
|---|---:|---:|---:|---:|---:|---:|
| 根会话，100 Turn × 10 tools | 386.6 / 473.4 | 2 | 0.202 | 0.09 | 0.14 | 230.7 |
| 根会话，300 Turn × 10 tools | 384.4 / 443.6 | 2 | 0.204 | 0.09 | 0.14 | 288.5 |
| 根会话，1,000 Turn × 10 tools | 386.0 / 718.8 | 2 | 0.204 | 0.13 | 0.18 | 245.4 |
| 单 Turn，1,000 tools | 2,654.1 / 3,295.3 | 16 | 2.427 | 2.17 | 2.24 | 276.4 |
| 单 Turn，单个 4 MiB 工具输出 | 302.7 / 318.0 | 1 | 0.0035 | 0.18 | 0.25 | 278.2 |
| 单 Turn，4 MiB assistant 正文 | 1,635.7 / 1,995.0 | 2 | 4.001 | 0.42 | 0.48 | 305.9 |
| 一层分支，100 Turn × 10 tools | 475.7 / 508.9 | 2 | 0.202 | 0.38 | 0.66 | 358.8 |
| 一层分支，300 Turn × 10 tools | 369.4 / 570.1 | 2 | 0.203 | 0.36 | 1.44 | 608.4 |
| 同一 300 Turn 分支，重启 app/Host 后 | 385.8 / 393.7 | 2 | 0.203 | 0.36 | 1.50 | 686.6 |
| 100 Turn 根会话恢复第一 Turn | 942.1 / 1,729.0 | 21 | 2.529 | 0.40 | 0.48 | 185.5 |
| 1,000 Turn 根会话恢复第一 Turn | 5,667.1 / 6,104.2 | 201 | 25.475 | 3.26 | 3.32 | 219.2 |

RSS 是整个进程在该状态下的采样值，不是单次切回新增内存；各 fixture 的总大小、分支复制以及 GC 时点不同，不能把表中差额直接当成某个函数的分配量。

普通工具为每次 4 KiB 的合成输出；工具前后还有固定大小的 reasoning/assistant 消息。100 Turn × 10 tools 与 1 Turn × 1,000 tools 使用同样的总工具数及单次负载，但 Turn 包装数不同，不宣称逐字节等长。

### 巨大单 Turn（极端合成场景）

把 1,000 次工具调用放入一个 Turn 后，完整 Turn 规则使初始读取越过 128 KiB 预算：16 次历史页读取、约 2.43 MiB Renderer 数据，可见时间中位数 2.654 s，Host CPU 2.17 s。分散到 100 Turn 时，只需打开最近 8 Turn、2 页、约 0.20 MiB，可见时间 0.387 s。

当前版本已经在首个小页切入 Turn 中段后使用 512 KiB 续读，因此上述结果包含该优化。不能把成本归因于“仍然一直以 128 KiB 读取”。Main 的 `readOlderPage` 等待总和中位数约 1.83 s；这包含请求链路与 Host 工作，不能直接当作独占投影 CPU。

单个 4 MiB 工具输出进入 Renderer 只有 3,708 bytes，不能用它证明完整 4 MiB 文本也很快。另测 4 MiB assistant 正文，实际传输 4,194,907 bytes，中位数 1.636 s、最大值 1.995 s。两种大 Turn 压力需要分别记录：大量工具事件与单个完整大消息。

### 长分支

通过真实 `sessions.branchFromTurn` 在源会话最后一个 Turn 创建一层分支，再测切回。分支创建不计入切回样本。这里的“长分支”是分支内历史长，不是多层祖先链。

100 Turn 分支：正文仍只有 2 页，但切回 Host CPU 中位数 0.38 s，高于同规模根会话的 0.09 s；显示后 1.5 s 还有 0.20 CPU s。完整周期分别为 0.66 与 0.14 CPU s。额外计算没有全部体现为首帧等待。

300 Turn 分支可见时间中位数 0.369 s，并没有随历史长度单调变慢；但完整周期 Host CPU 达 1.44 s，其中显示后还有 1.01 s。同规模根会话分别为 0.384 s、0.14 CPU s，显示后 CPU 中位数为 0。

进一步关闭 app/Host，复制包含已提交分支的 fixture，再启动新进程测五次返回：可见时间 0.386 s、完整周期 1.50 CPU s、显示后 1.09 CPU s。额外计算依然存在，不只是刚创建分支时未结束的工作。重启组的 Host 采样峰值中位数 686.6 MiB、组内最高 771.2 MiB；这仍不是持续增长或内存泄漏的证明。

代码仍允许有父会话的资源查询进入完整历史投影，这是额外计算的候选解释；本轮不以一个总体 CPU 增量声称已完成独占成本归因，也不据此引入缓存。

### 远距离恢复旧阅读位置

先通过页面的提示词刻度点击第一 Turn，确认它进入视口并保存位置；切走后再返回，测量真正的阅读位置恢复。

| 目标历史 | 第一次 ready 中位数 | 目标范围最后 ready 中位数 | 目标旧位置可见中位数 / 最大值 | 页数 | 实际加载 Turn |
|---|---:|---:|---:|---:|---:|
| 100 Turn × 10 tools | 87.1 ms | 681.4 ms | 942.1 / 1,729.0 ms | 21 | 100 |
| 1,000 Turn × 10 tools | 103.7 ms | 5,193.5 ms | 5,667.1 / 6,104.2 ms | 201 | 1,000 |

两组十次返回全部恢复到第一 Turn，顶部偏移为 0。大历史组实际传输 26,712,360 bytes（25.48 MiB）、401 批；Host CPU 中位数 3.26 s，Renderer CPU 2.414 s。页面最后只显示附近内容，并不意味着只读取附近数据：现有恢复 floor 会把从尾部到目标位置之间的范围补齐。

## 准备阶段失败与成本

这些不是切回样本，也不混入中位数：

- 100 Turn 分支的单次创建命令先报告 `operation outcome is unknown`；只查询原命令的结果，不重发，约 11.893 s 后观察到分支发布。
- 1,000 Turn / 10,000 tools 分支：命令同样返回结果未知，继续查询 600 s 仍未观察到发布，故 0 个切回样本。超时后保留数据和诊断，终止该隔离 Host，再运行其他场景。这证明创建路径存在严重成本或停滞，尚不能量化这种规模已有分支的切回时间。
- 初始 1 Turn / 4,000 tools fixture 原生导入超过 14 分钟仍未完成，主动中止并保留现场。它暴露的是导入/写入成本，不能记成巨型 Turn 的读取时间，也不能作为完成耗时。正式巨型 Turn 读取使用已通过完整校验的 1,000 tools fixture。
- 300 Turn / 3,000 tools 分支也先返回未知结果；查询同一命令后，约 91.360 s 观察到发布。这是一次准备操作的观测值，包含命令调用和结果查询，不是多次创建的统计分布。

## 判断与取舍

1. 根会话对照组的最近历史读取保持有界，支持现有优化方向在这些合成数据上的效果。
2. 巨大 Turn、远距离恢复在所测压力条件下出现明显成本；保留为极端回归测试，不由此认定日常使用已存在同等严重的问题。
3. 分支压力测试需要同时看首帧与总 CPU，并单列创建路径的超时。真实使用中是否经常出现相同历史规模和工具密度，仍需验证。
4. 优化优先级应结合真实会话的每轮工具数、历史长度、消息大小和操作频率确定。仅凭本轮压力数字，不足以增加持久投影、缓存、索引或其他架构复杂性。本轮没有改动产品代码、数据库结构或导出/WorkHub 的完整性语义。

## 正确性、复现与限制

fixtures 经原生存储导入，生成器检查 invocation 终止、工具已结算、没有硬投影诊断，并执行 SQLite integrity check。55 次成功返回全部检查目标 Turn 可见、历史页无错误；10 次正式旧位置返回的锚点偏移均为 0。创建超时和导入中止均单独保留。

测量脚本与数值样本位于本 evidence 分支，完整复现命令见 [EDGE-BENCHMARKS.md](EDGE-BENCHMARKS.md)，各次数据见 [edge-costs.json](edge-costs.json)。原始本地 report 还保留逐页耗时、批次、进程采样和截图；发布版不包含 userData、凭据或生成数据库。

本轮只测 macOS packaged、本地、终止会话。它不复现原 issue 的 Windows/WSL active remote 条件，也不替代先前 C 的受控远端测试。不与不同产品版本的旧 before/after 表混算降幅；没有测活跃巨型工具流、多层祖先链或所有类型的资源继承。

使用 Codex 按贡献者要求执行测试、整理证据。
