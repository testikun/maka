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

# Reproducing the September 29 extreme-scenario stress tests

**These are synthetic extreme-scenario and scale-boundary stress tests with root-session controls. Their frequency and representativeness in real usage have not been established. Measured costs under these conditions do not establish everyday performance or optimization priority.** A 1,000-tool single Turn and a single 4 MiB assistant message are deliberately constructed extremes; the latter was not validated as a naturally obtainable model response. Branching and restoring an old reading position are ordinary operations exercised here at selected stress sizes. A Turn is one task round within a session, not the entire session.

Product commit: `5017c7534780f21fef65ab13a93c92c95ce16a3e`. The evidence branch contains an older product tree: **do not build its HEAD as the measured product**. Use a separate checkout at the product commit and overlay `scripts/perf/` plus `scripts/fixture-env.mjs` from the evidence revision containing this document. Older reports remain pinned to their original evidence revision.

Use Node 24 and the repository's Electron/Playwright dependencies on macOS. All commands below run in that isolated product checkout. No real provider request is needed. Do not run against real userData or overlap fixture generation, package building, profiling, or multiple benchmark processes with timed runs.

```sh
npm ci
npm run build
node scripts/perf/issue-5712-edge-recipes.mjs
node scripts/perf/issue-5627-package.mjs artifacts/issue-5712-edge-costs/package
node scripts/perf/startup-fixture.mjs --config artifacts/issue-5712-edge-costs/recipe-read-costs.json --name issue5712-edge-read-20260929
node scripts/perf/startup-fixture.mjs --config artifacts/issue-5712-edge-costs/recipe-assistant-4m.json --name issue5712-assistant-4m-20260929
```

The first fixture contains source, 100-Turn root, 1,000-tool single Turn, 1,000-Turn root and 4 MiB tool-output sessions. The second contains source, 4 MiB assistant message and a 300-Turn root. The original larger `recipe.json` is retained to reproduce the aborted 4,000-tool import separately; it is not the recipe used for successful read measurements.

The fixture adapter updates its import to the current runtime's `READ_PAGE_MAX_BYTES` export. These recipes use command/MCP terminal snapshots, not the Read adapter; this campaign does not validate all historical fixture tool adapters against current main.

Run cases sequentially, using a fresh output/clone directory for each:

```sh
node scripts/perf/issue-5712-edge-campaign.mjs root-100
node scripts/perf/issue-5712-edge-campaign.mjs giant-1000
node scripts/perf/issue-5712-edge-campaign.mjs single-output-4m
node scripts/perf/issue-5712-edge-campaign.mjs root-1000
node scripts/perf/issue-5712-edge-campaign.mjs branch-100
node scripts/perf/issue-5712-edge-campaign.mjs restore-100
node scripts/perf/issue-5712-edge-campaign.mjs restore-1000
node scripts/perf/issue-5712-edge-campaign.mjs assistant-4m
node scripts/perf/issue-5712-edge-campaign.mjs root-300
node scripts/perf/issue-5712-edge-campaign.mjs branch-300
node scripts/perf/issue-5712-edge-summary.mjs
```

The selected case defaults to five returns. The second positional argument overrides count; the third adds an output/fixture suffix for a separate campaign, e.g. `root-100 5 -repeat`. The summary reads the unsuffixed cases. Keep repeated campaigns separate; do not overwrite or silently pool them.

For the additional restart control, finish `branch-300` and close its Host first. Copy its now-committed fixture to `artifacts/issue-5712-edge-costs/fixtures/branch-300-reopened`. Read the created branch's raw ID from the second array element of the JSON-encoded `edge.branchPreparation[0].id` in its report, and substitute it for `RAW_BRANCH_ID` below. This does not create another branch.

```sh
node scripts/perf/issue-5680-clone-fixture.mjs artifacts/issue-5712-edge-costs/fixtures/branch-300 artifacts/issue-5712-edge-costs/fixtures/branch-300-reopened
MAKA_BENCH_COMMIT=5017c7534780f21fef65ab13a93c92c95ce16a3e node scripts/perf/issue-5712-edge-switch.mjs --manifest artifacts/issue-5712-edge-costs/fixtures/branch-300-reopened/manifest.json --output artifacts/issue-5712-edge-costs/branch-300-reopened --runs 5 --state idle --observe-ms 1500 --source-dwell-ms 500 --target-session-id synthetic-session-0009 --source-session-id synthetic-session-0001 --existing-branch-id RAW_BRANCH_ID --executable artifacts/issue-5712-edge-costs/package/mac-arm64/Maka.app/Contents/MacOS/Maka --label branch-300-reopened
node scripts/perf/issue-5712-edge-summary.mjs
```

Run `branch-1000` separately when investigating its creation timeout. It issues exactly one real branch command. An unknown outcome is reconciled by session-list reads for up to 600 seconds, never by resubmission. In the recorded run it did not publish a branch, so there are no return samples. The busy isolated Host survived Desktop quit; it was terminated after collecting a separate native sample. Check the fixture registration and actual process command before terminating only that fixture's Host. The clone helper deliberately refuses to continue while the source identity has a live Host; do not bypass that guard.

The driver adds a lifetime-only Main wrapper around `DesktopTranscriptReplica.readOlderPage` to count pages and durations. The package's temporary preload probe measures actual transmitted fragment bytes and batches. No product source or persistent projection is changed. `--restore-first` uses the real prompt rail to establish the first Turn as the reading anchor, then tests away/return restoration. `--branch-depth 1` uses the real `sessions.branchFromTurn` API and keeps preparation outside return timings.

The numerical export retains per-return visible time, first and final-range ready time, page/batch counts, bytes, CPU, sampled Host RSS and anchor checks. Local reports additionally contain individual pages/batches, screenshots and process samples. `edge-package-identity.json` records four measured product module hashes, matched between the package and the fresh local build; this is not an assertion that every ASAR member was hashed.

`visibleMs` includes placement/fade and double RAF, not physical compositor presentation. CPU samples bracket the return and include measurement overhead. RSS sampling covers the complete target→source→target cycle and the following 1.5 seconds. Five returns support a descriptive median/maximum, not a tail guarantee. No new ablation of product behavior is performed in this measurement-only follow-up; the existing product ablations are recorded in the earlier report.
