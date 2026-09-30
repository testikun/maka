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

# Storybook CI 收尾修复

日期：2026-09-30。产品提交：`2a104db46c0acac7d5dd763da68096bdc3d0b60d`。先通过 `0e7b46c13` 合并上游 `d6876d708` 的 Plan 状态重构、解决架构统计文件冲突，再单独提交两个 Storybook 用例的修复。没有新增产品机制，也没有改动运行时滚动、分页或懒挂载逻辑。

此前提交 `929a30090` 的 [CI](https://github.com/apache/maka/actions/runs/36673158029) 通过了标准工作区测试、Runtime Host、Desktop E2E 和静态检查，但在 Storybook 中有两个真实失败。后续几何与 CLI 检查被跳过，不能把该次 CI 描述为全部通过。

## 原因与修复

`CompletedProcessCollapsed` 仍等待隐藏的过程正文出现，再断言不可见。这与“从未展开的已完成过程不挂载内容”的新契约冲突。改为断言正文不存在、过程容器没有挂载子节点，同时保留最终回答可见、折叠高度、左右对齐和无多余边框等几何断言。相关首次展开、再次折叠、运行结束自动折叠用例一并验证。

`NestedScrollerNearHistoryBoundaryAsksForNothing` 的准备步骤先模拟一次根滚动，立即派发合成 `scrollend`，随后直接把视口移到边界。在 Playwright Chromium 153 中，真实 `scroll` 事件仍排队等待处理，提前的结束通知不能终止这段尚未完成的滚动意图。后续准备动作因而被归入上一段向上滚动并触发读页。事件记录证明加载发生在对嵌套滚动区域派发 wheel 之前。

用例现在等待根元素的真实 `scrollend`，再经过既有滚动意图收尾所需的两个动画帧，然后设置边界。新增断言要求准备完成时加载数为零；保留嵌套滚动不请求历史、随后滚动根元素请求一次的原断言。没有增加时间超时、重试或全局完成协议。

## 验证与删除消融

- 用 CI 对应的 Playwright Chromium 153 复现了修复前的两个失败。系统 Chrome 中嵌套滚动用例通过，因此没有用系统浏览器的一次通过代替 CI 浏览器验证。
- 修复后的折叠、展开、生命周期完成、嵌套滚动四个相关故事均通过，且 runner 等待 `play` 断言完成。
- 在生成的 Storybook bundle 中实际删除等待真实 `scrollend` 的操作，准备阶段零加载断言重新失败；恢复后通过。修改仅用于实验，并在 `finally` 中恢复，未进入提交。
- 完整 Storybook：440 个故事、480 个主题渲染通过。原有 runner 对一个并发失败的 WorkHub 用例单独重试后通过；本次两个目标用例均直接通过，没有依赖该重试。
- 合并后的 Desktop 全套 3,089 项通过，完整工作区构建、类型检查、Storybook 类型检查和构建通过；对 `d6876d708` 的严格架构检查通过，包含 121 项检查器测试。
- 上次 CI 未执行的 transcript 几何检查在本地补跑通过：混合 24 Turn、45 tools、长代码三种场景，每种一次；冷、热阅读位置滑移均为零。它是几何正确性回归，不是新的性能分布。

[验证输出与失败事件记录](./ci-fix-validation.json)随本记录保存。之前的性能样本仍归属于原测量提交，未改标为本次提交的新实测。本地结果与 GitHub hosted CI 分开报告。
