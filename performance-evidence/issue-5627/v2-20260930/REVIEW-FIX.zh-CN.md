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

# 9 月 30 日 Review 修复与验证

产品提交：`d86fe4f1e0dcba72e9bb8027f641b77e3cf9c714`，基于 `2a104db46`。处理 Astro-Han 在 PR #5712 上提出的 1 条 P2 和 4 条 P3；没有新增缓存、持久化结构或后台加载循环。

## 修复

1. [读取期间的尾部增长](https://github.com/apache/maka/pull/5712#discussion_r4141912939)：一个向前读取响应走到其快照尾部后，如果 Host 已新增内容且本次预算尚未用完，继续读取相邻缺口，再交接给实时更新。达到预算则保留分页；重连传入的精确窗口上界始终保持。真实 SQLite 账本集成覆盖读取期间追加、之后继续追加、已读确认、预算停止以及重连范围。
2. [取消落盘确认误报错误](https://github.com/apache/maka/pull/5712#discussion_r4141912955)：后台 `waitForDurableMessage` 被导航取消时返回 `false`，不再传播成刷新失败。Host 真实读取错误仍拒绝；完整导出被取消也仍拒绝，不返回残缺结果。测试覆盖独立读取打开中和等待落盘中两个取消时机。
3. [首次读取预算未透传](https://github.com/apache/maka/pull/5712#discussion_r4141912965)：补齐 candidate 依赖声明与 observer 参数传递。测试从 candidate 和实际 IPC 入口走到 Host page request，确认配置的 1 MiB 开始预算生效；单个 Host 页仍受现有 512 KiB 上限约束。
4. [旧窗口错误显示 Resume](https://github.com/apache/maka/pull/5712#discussion_r4141912973)：只有显示范围覆盖真实尾部时，才向候选 Turn 提供 Resume 操作。旧窗口中即使最后一个可见 Turn 被停止，也不展示会作用于真实最新 Turn 的错误入口。
5. [到达尾部后重复打开](https://github.com/apache/maka/pull/5712#discussion_r4141912986)：定位状态仅持续到本次打开完成。书签或搜索定位后，如果已经读到尾部，发送所需的 `showLatest` 直接复用当前窗口，保留已加载历史；未完成的定位仍可被“回到最新”取消。

## 验证

- Node 24，全工作区 `npm run build` 和 `npm run typecheck` 通过，后者包含 Storybook 类型检查。
- Desktop 全套 **3,099/3,099**，UI 全套 **698/698**，针对性套件 **97/97** 通过。
- `partial-history-notice.spec.ts` 的既有 Electron 用例 **1/1** 通过：向上滚动自动补页直到历史开头，再返回最新。没有新增 Electron 用例或放宽超时、重试、断言。
- 严格 renderer 架构检查（基线 `d6876d708`，含 121 项检查器测试）、Biome、Windows inventory 119 项、ASF、protocol epoch 199 与 diff 检查通过。
- 与当时最新上游 `4c79e3910` 的 `git merge-tree --write-tree` 无冲突；没有为本次修复合并额外上游变更。
- 产品提交仅含 4 个产品文件和 4 个测试文件；实验文件与日志留在独立证据分支。

## 删除消融

在已构建的 JavaScript 中逐项删除行为，每次独立运行相应回归，并在 `finally` 恢复。以下 8 个实验均被行为断言或未结束操作检测到：

- 删除尾部缺口续读：小缺口仍留下 `hasNewer`，回归失败。
- 删除续读预算条件：600-byte 用例过度追读，回归失败。
- 删除固定恢复上界条件：以更大预算重连时擅自扩展旧窗口，回归失败。
- 删除取消时的静默结束：打开中与落盘等待中均出现拒绝，回归失败。
- 删除 candidate 参数透传：Host page request 退回默认 128 KiB，回归失败。
- 删除 Resume 的尾部条件：旧窗口重新展示错误操作，回归失败。
- 删除定位完成后的状态释放：`showLatest` 重新打开并丢失已加载范围，回归失败。
- 尝试完全省掉“定位中”保护：旧视图已覆盖尾部时，回到最新无法取消待完成的 seek，用例超时。保留这一个现有状态位的必要语义，没有增加第二套状态。

[验证记录和消融输出](./review-fix-validation.json)随报告保存。消融后重新完整构建并运行上述通过的测试，实验修改未进入产品提交。

## 保留的取舍与数据口径

Review 另提到 WorkHub 全量读取没有首读上限。这里继续保持此前的正确性决策：整个会话的链接和筛选需要完整历史。重新加硬上限会使结果不完整；另建 Host 索引或投影需要独立评估数据模型、存储和一致性成本。本次没有实现该非阻塞建议。

本次没有重跑性能分布，原报告的性能数据继续对应原构建版本。此前 `2a104db46` 的 hosted CI 已通过；本提交的 [CI](https://github.com/apache/maka/actions/runs/36686861355) 在记录发布时仍运行中，本地通过不等同于该次 CI 已通过。
