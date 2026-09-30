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

# Transcript 极端场景优化 v2：旧位置直达与折叠过程按需挂载

日期：2026-09-30。版本：v2。状态：已按本方案实施，功能提交 `79fd458d2`，合并主分支后的交付提交 `929a30090`，见[实现与验证报告](./README.zh-CN.md)。以下保留评审时的设计依据和验收标准；文中“待验证”描述的是实施前状态，实测结论以验证报告为准。

本版按评审意见收敛范围：**暂缓超长 Markdown 优化；第一阶段只做旧位置直达与折叠过程按需挂载两个独立实验；巨大 Turn 的 Host 重复投影先归因，是否改实现由证据决定。** 保留原有极端压力数据，不把它们改写成正常使用需求。

本轮核对 PR #5712 工作树 `8d73d4e237609dd784b816181a8e4cc2061a7579`；已有发布包性能数据来自 `5017c7534780f21fef65ab13a93c92c95ce16a3e`，不冒充当前提交的新实测。旧的启动调研（本地文档 `docs/startup-optimization-plan-2026-09-21.zh-CN.md`）仅用于追溯 Codex、Claude 的参考设计；Maka 的判断重新依据当前代码。

## 1. 建议的大方向

**继续复用现有事件账本、Turn 索引和分页协议，使读取范围由阅读位置决定，使渲染工作由实际展示内容决定。优先删除无用工作，不增加一套持久投影或全局缓存。**

本版处理两个不同边界：从尾部向前分页没有限制恢复旧位置所跨越的距离；按 Turn 虚拟化没有免除巨大 Turn 内部隐藏内容的挂载。二者分别改读取起点与挂载时机，不需要合并为新框架。超长正文另有单条内容的解析与布局成本，本版保留其边界记录。

| 场景 | 建议 | 时间、CPU 收益所在 | 新增持久存储 | 主要代价与优先级 |
|---|---|---|---|---|
| 恢复 1,000 Turn 开头 | 用已有索引直达目标，读取目标附近的连续窗口 | 去掉目标与尾部之间无关历史的读取、投影、传输和组装 | 0 | 中等：Desktop 范围、已读和重连契约要调整；最值得优先验证的结构改动 |
| 单 Turn 1,000 工具调用 | 延迟挂载未展开的执行过程；独立测量 Host 重复投影 | 挂载优化减少 Renderer 无用工作，Host 收益另行验证 | 0 | 较低；本版不引入 Turn 内分页或跨页投影缓存 |
| 单条 4 MiB 正文 | 暂缓，保留已测数据 | 本版没有专项提速目标 | 0 | 不设计正文预览、阅读器、AST 缓存或 Worker |

这里的“优先”同时考虑正常使用收益：搜索定位、恢复阅读、折叠执行过程都是正常操作。1,000 tools 和 4 MiB assistant 正文仍是**人工极端压力场景**，发生频率未知，不因出现秒级数据就默认值得做复杂机制。

## 2. 当前证据能说明什么

已有[极端压力报告][edge-report]为 macOS packaged、本地 isolated Host、已终止会话，同进程切走再返回，每组 5 次。下表为中位数。可见终点是目标 DOM 放置完成、透明度达标、两个 RAF 后通过视口断言，不是物理屏幕呈现或完全稳定时间。

| 场景 | 目标可见 | Main 历史页调用数 | 进入 Renderer 的字节 | 切回 Host CPU | Renderer CPU |
|---|---:|---:|---:|---:|---:|
| 100 Turn，恢复最近历史 | 386.6 ms | 2 | 212,248 | 0.09 s | 0.464 s |
| 1,000 Turn，恢复最近历史 | 386.0 ms | 2 | 213,896 | 0.13 s | 0.471 s |
| 单 Turn 1,000 tools | 2,654.1 ms | 16 | 2,544,535 | 2.17 s | 0.890 s |
| 单条 4 MiB assistant 正文 | 1,635.7 ms | 2 | 4,194,907 | 0.42 s | 1.265 s |
| 100 Turn，恢复第一 Turn | 942.1 ms | 21 | 2,651,940 | 0.40 s | 0.999 s |
| 1,000 Turn，恢复第一 Turn | 5,667.1 ms | 201 | 26,712,360 | 3.26 s | 2.414 s |

CPU 是相应进程的累计 CPU 增量，不能与墙钟时间相加，也不是函数级归因。Main 页调用内部可能为一条大消息续读多个 Host 分片，不能把 4 MiB 正文的“两页”理解成仅两次 Host 请求。原始数值见[数据文件][edge-data]。

当前已有的优化包括：首读约 128 KiB、续读约 512 KiB；历史切页与完整 Turn 边界协调；Renderer 按 Turn 虚拟化；增量 transcript 投影；受限副本；工具详情按需展示。后续方案不能重新把这些当作待实现收益。

三个关键判断：

1. **远距离恢复在做距离相关的多余工作。** 1,000 Turn 的首次 ready 约 104 ms，但目标范围最后 ready 约 5,194 ms。当前恢复仍把目标到尾部的历史全部补齐，不能用首次 ready 代替恢复成功。
2. **巨大 Turn 包含 Host 和 Renderer 两段成本。** Host CPU 2.17 s，说明仅减少 DOM 不足以解决全部等待。源码还显示跨页会再次读取、投影同一 invocation；其独占耗时需要额外计数与 profile 确认。
3. **4 MiB 正文保留为已知极端边界。** ready 约 557 ms，目标可见约 1,636 ms，Renderer CPU 1.265 s；这些数据不等于 Markdown parser 的独占成本。本版暂缓处理，不把此项未提速作为交付失败。

这些不是原 issue 的 Windows/WSL active remote 复现，也不是首次 Host ready 的 B 场景启动成绩。

## 3. 最值得做的结构调整：按锚点打开一个连续范围

### 3.1 复用条件已经存在

当前有三块可复用能力：

- `runtime_session_turn_extents` 记录 Turn 起止 ordinal，可按 session、turn 的主键定位；事件的 session/ordinal 范围也有现成索引。[存储查询][m-query]
- Host 页协议已有 `direction: newer`、`anchorSequence`、`throughSequence`。请求的上界可以小于订阅已知高水位。[Host 分页][m-pager]
- Desktop replica 的 `readTurn()` 已通过 Turn 起止位置向前读取，证明该调用方向已存在；但它为单 Turn 操作过滤其他 Turn 的行，不能原样用于正常会话阅读。[Replica][m-replica]

缺口主要在 Desktop：当前 range 是从某个 floor 到尾部的连续后缀，恢复调用 `loadEarlier(targetSequence)`。索引找到了位置，但位置被用作“补齐到这里”的终点。[恢复逻辑][m-restore] [范围契约][m-range]

### 3.2 建议的最小契约

打开位置由现有阅读锚点决定：最新位置走现有尾读；明确的旧位置先查 Turn extent，再从它的开始位置向后读。可以使用 `anchorSequence = firstSequence - 1`，在同一订阅已知高水位内选择读取上界，按预算在安全的 Turn 边界交付目标附近范围。原始 ordinal 和 transcript sequence 不是同一单位，转换必须沿用现有逻辑。

第一版保留**一个连续阅读范围**，不同时维护多个相距很远的历史岛：跳转旧位置时替换当前阅读范围；向上、向下接近范围边缘时自动加载相邻内容；跳回最新时再打开尾部范围。无需“载入更早记录”按钮，也无需启动后后台补齐整段历史。

这不意味着第一版同时建设 Renderer 双向裁剪算法。范围可随连续阅读扩展，沿用现有可用的内存限制；本方案解决的是跳转/恢复前必须付出的距离成本，不承诺连续读完整个会话后 Renderer RSS 仍为固定值。

新增状态应只表达必要事实：当前范围的起止、两端是否还有内容，以及所属 generation。继续复用原有订阅和游标，不自制可绕过 Host 校验的游标，不持久化另一份 transcript。

实现时分别定义三个值，不能继续由 `durableThrough` 一项同时承担：订阅已知的高水位 H、当前阅读范围的末端 U、已确认的尾部已读位置 A。它们是契约含义，具体命名沿用现有类型；高水位与确认状态已有来源，不另建持久状态。普通旧窗口可以满足 U < H，此时 ready 只代表该窗口完成。

页链固定其读取快照和方向；上、下两个方向的游标独立管理。切换快照不能继续使用旧游标。相邻关系由 Host 的覆盖证明判断，不能用序列号加一推断，因为实际序列允许间隔。[Desktop 批次契约][m-contract]

| 用户操作 | 最小处理流程 | 完成标准 |
|---|---|---|
| 恢复或搜索命中旧 Turn | 按 Turn ID 定点查询 extent → 读取附近连续范围 → 沿用批次组装，在 ready 时安装范围 → 恢复锚点偏移 | 目标 Turn 真实可见；不先补齐目标与尾部的间隔 |
| 向上或向下继续阅读 | 接近对应边缘时自动读取相邻页；相同边缘的重复触发合并 | 只接合可证明相邻的内容；视口锚点不跳动 |
| 再次跳转到远处 | 取消旧定位请求，以现有请求身份/generation 丢弃迟到结果，替换当前窗口 | 仅最后一次目标生效，不保留多个历史窗口 |
| 回到最新 | 重新打开尾部范围，接回现有连续 tail 更新 | 尾部范围安装后按现有已读规则确认；仅旧窗口就绪不能触发该确认 |
| 在旧位置发起新消息 | 发起尾部定位并沿用原有提交、草稿、回执流程；命令执行不等待旧历史补齐 | 当前用户的新任务进入最新视图；窗口加载失败不冒充提交失败、不触发重复提交 |

锚点已知时应在 open 阶段携带定位意图，避免必须先完整加载最近历史再定位旧位置。现有订阅 bootstrap 所需的有限尾部工作可以保留并计量，不再创建第二个尾部缓存。Turn lookup 使用已有按 ID 查询，避免先枚举全部历史再找目标。

### 3.3 必须一起处理的正确性

| 边界 | 要保持的行为 |
|---|---|
| 订阅高水位与可见范围 | Host 已有到 H 的事件，不代表页面加载到 H。范围上界与订阅高水位必须分别表达 |
| 已读 | 在旧窗口 ready 时，不能沿用当前 `acknowledgeTail(H)` 把未看到的最新内容标记已读 |
| 活跃会话 | 保留现有状态观察；不能将跨越缺口的新尾部消息直接拼进旧窗口并声称连续。窗口内更新遵守原有权威语义；新内容提示与回到最新另行处理 |
| 发送与流式结束 | 当前 `refreshMessages()` 会在阅读 store 中等待指定 assistant 消息。旧窗口不包含它时，不能把缺席当作提交失败或永久阻塞 live→durable 交接；必须结合当前阅读意图区分“回执/持久化已确认”与“正文已在当前视图发布” |
| 完整读取 | 导出、复制整个会话、WorkHub 等操作仍走明确的完整读取。`hasOlder=false` 只能证明没有更早内容，不能证明没有更晚内容 |
| 重连与切换 | generation 改变时取消旧请求；按保存的锚点重新定位。不能复用另一订阅的游标，也不能悄悄丢失已承诺恢复的位置 |
| 嵌套、交错 Turn | 范围内所有可见行保持原顺序，不照搬 `readTurn()` 只保留目标 Turn 的过滤；遇到跨窗口 invocation 时仍按现有语义闭包处理 |
| 锚点不可用 | 保持可解释的目标不可用处理；不把未加载当作不存在，不自动触发整段历史扫描来掩盖错误 |

尽量只调整 Renderer/Main 的阅读范围契约。先在现有 Host 协议上验证；若边界语义确实不够，再按既有能力协商增加最小字段。旧 Host 仍可保留原有顺序读取行为，不在首版要求数据库迁移。

发送是明确的“前往最新”意图，单纯收到后台新消息不是。用户发送后又主动滚回旧历史时，以最新的阅读意图为准；不能由流式完成回调再次强制拉回底部。以上发送/结束交接必须作为同一改动的验收，不能留到性能上线后再补。[现有刷新与交接检查][m-actions]

### 3.4 已完成的只读消融实验

本轮在已有 2026-09-29 fixture 上，用 SQLite `mode=ro` 和 `query_only=ON` 比较两种事件范围：目标处 8 个普通 Turn；目标到会话尾部。没有新增索引、缓存或持久投影，schema_version 保持不变。

| 历史与目标（索引从 0 开始） | 直达 8 Turn 的事件数 / 原始 payload 字节 | 从尾部补到目标的事件数 / 原始 payload 字节 |
|---|---:|---:|
| 100 Turn，目标 0 | 512 / 1,054,496 | 6,400 / 13,217,020 |
| 1,000 Turn，目标 0 | 512 / 1,054,496 | 64,000 / 132,546,860 |
| 1,000 Turn，目标 500 | 512 / 1,060,704 | 32,000 / 66,294,000 |

`EXPLAIN QUERY PLAN` 命中 Turn extent 主键、session/ordinal 主键与 event_id 索引。删除“直达范围”后，需要覆盖的输入随距离增长；保留它而不增加任何缓存，范围仍能定位。

**结论仅是现有存储支持定位普通 Turn 的小范围。** 这不是优化后的产品 reader，不是端到端性能实验；原始 payload 字节不同于投影后传输字节，不能宣称提速 125 倍。交错 invocation、权限语义、实时更新和 Desktop 范围安装仍需产品实验。“8 Turn”是本次对照条件，不是推荐硬编码默认值。

复现脚本：[anchor_range_probe.py](./research/transcript-extreme-2026-09-30/anchor_range_probe.py)。结果：[anchor-range-probe.json](./research/transcript-extreme-2026-09-30/anchor-range-probe.json)。参数为原 fixture 的 `manifest.json` 路径；数据库不纳入文档。

## 4. 单 Turn 1,000 tools：先分清隐藏内容与重复投影

### 4.1 第一项先做小实验：折叠内容首次展开才挂载

当前外层 `ProcessingBlock` 使用关闭的 `<details>`，但其 body 仍无条件遍历、挂载 `TurnTimelineEntry`。HTML 折叠隐藏了展示，不等于 React 没有创建子树；工具组件内部已有延迟挂载，也不等于外层 reasoning、commentary 和其他条目全部免除工作。[ProcessingBlock][m-processing]

最小候选是把现有工具详情的懒挂载原则扩展到外层：已结束且从未展开的过程只挂摘要；首次展开再挂内容。对用户已打开的交互状态谨慎保留，活跃过程仍按原生命周期展示。不要在每次折叠时粗暴卸载，导致输入、选区或展开状态丢失。

| 过程状态 | 内容子树 | 需要保留的行为 |
|---|---|---|
| 历史已结束，本次组件生命周期从未展示 | 不挂载 body 条目 | 摘要、状态、展开入口与可访问名称正常 |
| 首次展开 | 挂载现有 body | 展开后内容完整，无重复工具或缺失文本 |
| 已展开后再折叠 | 保留已挂载子树 | 工具输入、详情展开状态与选区行为不因折叠被清空 |
| 运行中，或本次生命周期曾展示实时过程 | 按现有生命周期挂载并保留 | 流式结束回调和 live→durable 交接不依赖一个被跳过的子树 |
| Turn 被现有虚拟列表卸载 | 随组件释放 | 不新增跨 Turn 或跨会话的挂载状态缓存 |

只需组件内“曾经展示过”这一类最小事实，不新增条目分页、第二层虚拟列表或背景预渲染。该状态必须覆盖初始即 running 以及运行中结束两种情况，不能只记录用户点过展开。沿用现有工具详情保留状态的测试原则。[已有懒挂载测试][m-mount-test]

此项没有新持久存储，也不需要跨会话缓存。必须同时测“切回可见”和“首次展开”：若只是把同样的长卡顿移到用户更常用的展开操作，就需要调整或回退。副作用、完成回调、无障碍与查找行为也需要核对，不能只用元素数减少证明正确。

### 4.2 Host 侧先消除重复，别直接引入第二套投影

当前 reader 每次 scan 会找到一个 invocation，把相关事件送入现有 projector，生成记录后再筛选请求范围；下一页重新进入这条路径。大消息分片续读也可能重复序列化同一条大记录。[Reader][m-reader]

因此，分页只限制响应大小，不保证投影 CPU 同样有界。可把候选成本理解为“每页重复处理的 invocation 输入 × 页数”，但具体重复量要用调用计数与 profile 验证，不能把 16 次 Main 页调用直接乘成精确投影次数。

本版只增加归因任务：记录每次打开的唯一 invocation 数、实际投影次数、重复读取事件数、序列化字节数和取消后的剩余工作。使用局部计数/独立 profile，不建设持久遥测或缓存框架。

后续仅在重复工作被证明确实占主要成本时，才细化不复制持久数据的有界 Host 方案。候选实现还需证明取消和正常会话无显著回退，才能保留。下表保留为未来选择，不是本版待实施清单：

| 方向 | 优点 | 代价与结论 |
|---|---|---|
| 有界读取操作内连续消费同一次投影结果 | 不改变完整 Turn 的展示语义，不落盘；可能把重复投影变成一次 | 需要跨页生命周期、取消、内存上限、watermark/generation 隔离；仍是新增临时保留状态。只有实测收益足够时才接受，不能包装成“零缓存成本” |
| Turn 摘要与内部条目分别读取 | 用户未展开过程时可少读、少传、少挂载，方向上更彻底 | 当前事件到展示行不一一对应，需要工具配对、权限结果、续接与不完整状态契约；改动面大。暂不为单一极端样本直接实施 |

前者是局部消除重复的候选，后者是产品读取模型调整。两者本版都不预先引入；读取操作内复用也不能演化成无限期保留巨型 Turn 的 LRU。若最终需要跨页保留状态，应作为单独设计变更重新评估，不随 Renderer 懒挂载一并加入。

### 4.3 为什么不能简单读取最后几百个事件

当前 storage 对 invocation 读取到指定上界的事件，之前的事件参与 projector 的语义恢复。直接给它加下界或 `LIMIT`，可能丢失工具调用与结果的对应、权限结果或其他先决事实。

真正的 Turn 内分页，需要先定义哪些条目可独立显示、哪些依赖必须随页闭包读取，部分数据也必须显式标为未加载。当前已有 `readLatestAssistantForTurn` 仍要经过完整 invocation 投影，不能把它当作免费的 Turn 摘要接口。

**取舍：先接受巨大 Turn 仍有自身大小相关的读取成本。** 只有真实会话分布和消融数据证明它值得，才设计语义上的部分 Turn；首轮不新增摘要表、checkpoint 或另一套投影器。

## 5. 超长 Markdown 暂缓

按本次评审决定，从当前实施与性能目标中移除 4 MiB 正文专项：不改变正文显示，不引入预览阈值、独立阅读器、Markdown 块虚拟化或解析 Worker。原始压力样本与结果保留为已知边界。

暂缓依据是目前缺乏真实需求证据、专项成本与优先级不匹配；不将某个模型的上下文容量换算成所有正文的系统硬上限。只有后续真实使用或明确产品需求反复暴露正文解析/布局瓶颈，再单独启动该方向。

普通 Markdown 正确性仍随现有测试覆盖。4 MiB 样本可用作通用分片与完整性回归，但不要求本轮为它达到新的耗时指标，也不新增正文大小/结构专项参数扫描。

## 6. Codex 与 Claude 的参考价值和边界

本轮复核的是旧调研固定版本的源码，不把它们当作当前客户端实现的保证。

Codex 公开 core 的 `list_turns` 支持 `NotLoaded`/`Summary`，`list_items` 单独分页，并返回前后方向的游标；其查询依托 `thread_turns`、`thread_items` 等已有持久数据结构。[读取接口][codex-read] [存储分页][codex-pages]

这支持“Turn 概况与内部内容不必同时加载”的设计思路，也说明它的便利不是没有数据维护成本。Maka 可以借鉴按需读取的契约，不必复制整套持久 materialization。公开 core 源码不能证明 Codex 桌面端对这三个 fixture 的帧率、缓存策略或真实体验。

用户指定的 `bug-superman/claude-code` 仓库中，`readTranscriptForLoad` 从文件开头分块读，处理 compact 边界和保留片段，再形成待加载内容。[源码][claude-load] 可借鉴的是尽早减少进入后续对象构造的数据；它仍有顺序扫描，并不能证明 Claude 使用任意位置直达，更不是 Anthropic 官方桌面端实现的证据。

因此，不能因为 Codex 体验顺滑就推导出 Maka 需要新增缓存；也不能因为参考实现支持摘要就省略 Maka 事件语义与持久化成本的评估。

## 7. 实施顺序、预算与验证

建议分成独立、可回退的实验，不创建通用“高性能 transcript 框架”：

1. **旧位置直达的纵向实验。** 使用现有索引与 Host 协议，贯通定位、双向自动加载、恢复偏移、已读、发送交接和完整导出。普通 Turn 场景先验证，但嵌套、交错和活跃会话通过前不能交付。
2. **独立实验折叠过程懒挂载。** 以切回、首次展开、再次展开、活跃到结束的整个周期评估。这一项可以独立验收和回退，不依赖第一项完成。
3. **对巨大 Turn 重复投影做归因。** 交付调用计数与独立 profile 结论；是否需要后续 Host 改动单独决定。本版完成不以引入投影复用或 Turn 内分页为前提。

首轮预算：零新增持久表、索引与重复正文；零新增跨会话缓存、跨页投影缓存；新增状态仅限现有生命周期内的阅读范围/请求身份和组件曾展示标记。后续若要突破预算，必须给出同等收益下更简单方案失败的证据。

### 最小改动地图

| 改动位置 | 本版职责 | 避免扩张到 |
|---|---|---|
| 阅读位置控制器与 Desktop bridge 契约 | 传递 latest/目标 Turn 的打开意图，表达连续范围与双向加载 | 新建独立阅读服务、保存第二份正文 |
| Main observer 与 replica | 复用索引、现有页请求和投影；按目标打开、按方向接合 | 新数据库结构、通用稀疏区间管理器 |
| Renderer range store 与 chat 交接 | 验证覆盖、安装窗口、恢复偏移；区分窗口 ready、尾部已读与任务执行回执 | 让阅读窗口成为新的执行状态权威 |
| `ProcessingBlock` | 在现有组件中延迟首次挂载，保留已展示子树 | 新的工具数据投影、内层虚拟列表 |
| 性能实验工具 | 按一次打开关联读取、投影、传输和挂载工作量 | 常驻采样、持久遥测平台 |

第一阶段仍接受两个边界：巨大 Turn 可能继续需要完整投影；连续阅读大量历史仍会扩展阅读范围。它们不会被包装成此次已经解决的问题。

### 正确性先于性能

- 目标 Turn 与恢复偏移正确；连续阅读无漏行、重复和顺序改变；没有用相似内容或 skeleton 提前报成功。
- 旧窗口 ready 不标记尾部已读；完整导出不漏中间或更晚历史；正常工具配对、权限事实、失败/未知状态不变。
- 快速连续跳转、切换 session、Host 重连和请求取消不串 generation；部分消息分片完整解码后才作为消息提交。
- 嵌套、交错、分支可见性和活跃更新通过专项；不以普通顺序 fixture 的正确性代替全部事件语义。
- 在旧窗口发送后能正确看到新任务，流式结束能完成交接；发送后主动回看旧内容不被后台回调拉回，窗口错误不触发命令重发。
- 从未展开的已结束过程无隐藏条目挂载；运行中过程不丢回调；首次展开内容完整，折叠再展开保持现有交互状态。

### 性能验收

先用小样本归因；正式 before/after 固定提交、构建方式和数据集，至少 50 次有效返回再描述尾部变化，保留冷/热与首个样本。计时与 profiler 分开运行，报告 p50、p95、最大值与样本数。

| 验收面 | 需要证明什么 |
|---|---|
| 旧位置距离 | 固定目标邻域内容，增大目标到尾部距离，实际读取/投影/传输不再随中间 Turn 数等比例增加；索引定位与元数据成本单列 |
| 工具数 | 10/50/100/300/1,000 tools 梯度；记录挂载数、投影次数、隐藏过程 CPU 和首次展开时间 |
| 用户时间 | 区分首次 ready、目标范围 ready、正确位置可见、首次展开、输入响应；不能把加载中占位当成目标可见 |
| 总资源 | Host/Main/Renderer CPU、传输字节、事件数、RSS 和取消残余；包括显示后后台工作，不把成本藏到首帧之后 |
| 正常回归 | 最近历史、普通消息和活跃会话不能出现超出重复测量噪声的系统性退化；本地、受控 RTT 远端分别报告 |

不预先承诺 5.67 s 降到 0.4 s。直达消除的是“距离成本”，目标 Turn 自身很大时仍有“内容成本”。组合场景“恢复开头恰好是 1,000 tools”必须单测，避免分别优化后误报整体已解决；不把 4 MiB 正文专项加入当前提速验收。

实验保留原版、仅直达、仅懒挂载、二者结合四组，区分各自收益。固定目标附近内容，在 100/300/1,000 Turn 的不同距离下比较；每组都统计整个切换与展开周期，取消后检查剩余工作和内存能否回落。先通过上述正确性，再开展正式 packaged 计时。

### 设计消融与停止规则

| 移除什么 | 当前结论或后续判定 |
|---|---|
| 新持久缓存、摘要投影、额外索引 | 本次只读实验不需要它们也可定位目标范围，首版不引入；产品正确性仍待验证 |
| 目标直达，恢复原有尾部补齐 | 已完成存储范围对照：1,000 Turn 开头由 512 个目标事件变成 64,000 个范围事件，支持保留直达方向 |
| 多个历史窗口与自动全量预取 | 单窗口足以描述目标流程，没有现有证据要求它们，从方案删除 |
| 外层懒挂载 | 产品实验尚未做；比较有/无门控的完整交互周期，无显著收益或行为回归就恢复原实现 |
| 读取操作内投影复用 | v2 从当前实现范围删除，改成先归因；两个已选方向不依赖它 |
| 正文预览、阅读器与展示预算 | v2 全部从当前方案移除，旧位置直达和工具过程按需挂载的目标仍成立 |
| 当前窗口与高水位的区别 | 设计级反例：旧窗口 U < H，却按 H 确认尾部，会错误标记未覆盖内容；此区分不能删，待行为测试验证 |
| 组件曾展示标记，只用当前 open 决定挂载 | 设计级反例：折叠会卸载已打开详情，运行结束也可能丢子树；保留最小生命周期事实，待行为测试验证 |

本版消融分为两类：第 3.4 节是上一版已执行、可复现的只读存储实验；本次是收窄方案并用验收目标检查必要状态，尚未执行产品 A/B。实现后的四组对照才用于确认实际时间、CPU 和内存收益。

当前交付范围由两个产品实验和一项归因组成。通过验收就结束这一轮，不因为仍存在极端内容成本继续扩建缓存、投影或阅读框架。

[edge-report]: https://github.com/testikun/maka/blob/db55a33bb60f714ad28457563d4bc43e27028c75/performance-evidence/issue-5627/EDGE-COSTS.zh-CN.md
[edge-data]: https://github.com/testikun/maka/blob/db55a33bb60f714ad28457563d4bc43e27028c75/performance-evidence/issue-5627/edge-costs.json
[m-query]: https://github.com/testikun/maka/blob/8d73d4e237609dd784b816181a8e4cc2061a7579/packages/storage/src/runtime-transcript-query.ts
[m-pager]: https://github.com/testikun/maka/blob/8d73d4e237609dd784b816181a8e4cc2061a7579/packages/runtime-host/src/server/session-transcript-pager.ts
[m-replica]: https://github.com/testikun/maka/blob/8d73d4e237609dd784b816181a8e4cc2061a7579/apps/desktop/src/main/desktop-transcript-replica.ts
[m-restore]: https://github.com/testikun/maka/blob/8d73d4e237609dd784b816181a8e4cc2061a7579/apps/desktop/src/renderer/features/conversation/controller/transcript-reading-position.ts
[m-range]: https://github.com/testikun/maka/blob/8d73d4e237609dd784b816181a8e4cc2061a7579/apps/desktop/src/renderer/platform/desktop/desktop-transcript-range-store.ts
[m-processing]: https://github.com/testikun/maka/blob/8d73d4e237609dd784b816181a8e4cc2061a7579/packages/ui/src/chat-turn.tsx#L1434
[m-reader]: https://github.com/testikun/maka/blob/8d73d4e237609dd784b816181a8e4cc2061a7579/packages/runtime-host/src/server/session-transcript-reader.ts
[m-contract]: https://github.com/testikun/maka/blob/8d73d4e237609dd784b816181a8e4cc2061a7579/apps/desktop/src/preload/transcript-contract.ts
[m-actions]: https://github.com/testikun/maka/blob/8d73d4e237609dd784b816181a8e4cc2061a7579/apps/desktop/src/renderer/app-shell-chat-actions.ts#L552
[m-mount-test]: https://github.com/testikun/maka/blob/8d73d4e237609dd784b816181a8e4cc2061a7579/packages/ui/src/__tests__/tool-group-mounting.test.tsx
[codex-read]: https://github.com/openai/codex/blob/a86631502d49274cb47208925c7d3dcece032029/codex-rs/thread-store/src/local/thread_history/read.rs#L95-L173
[codex-pages]: https://github.com/openai/codex/blob/a86631502d49274cb47208925c7d3dcece032029/codex-rs/thread-store/src/local/thread_history/segment_paging.rs
[claude-load]: https://github.com/bug-superman/claude-code/blob/0753dafcccf433abc40a3de6abaa24ddce7d86f3/src/utils/sessionStoragePortable.ts#L715-L780
