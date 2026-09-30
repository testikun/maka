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

# Reproducing the v2 experiments

Use Node 24, macOS arm64, and a disposable checkout of the final product revision from PR #5712. The evidence branch contains harnesses, not the current product implementation. Restore its `scripts/perf` directory into that product checkout before running the commands below. Install the repository dependencies and run the full build first.

The build script compares the product checkout with `8d73d4e237609dd784b816181a8e4cc2061a7579`. It temporarily changes tracked sources to build four independent packages and restores them in `finally`. Run it only in an otherwise clean, isolated checkout, without other editors, tests, or builds using that directory. Baseline and lazy-only builds do not include the indexed-window integration test.

```sh
mkdir -p artifacts/issue-5712-v2
node scripts/perf/issue-5712-edge-recipes.mjs
node scripts/perf/startup-fixture.mjs --config artifacts/issue-5712-edge-costs/recipe-read-costs.json --name issue5712-edge-read-20260929
node scripts/perf/issue-5712-v2-recipes.mjs
node scripts/perf/startup-fixture.mjs --config artifacts/issue-5712-v2/gradient-recipe.json --name issue5712-v2-gradients-20260930
node scripts/perf/issue-5712-v2-build.mjs
node scripts/perf/issue-5712-v2-campaign.mjs pilot
node scripts/perf/issue-5712-v2-campaign.mjs formal
node scripts/perf/issue-5712-v2-campaign.mjs gradient
node scripts/perf/issue-5712-v2-campaign.mjs extra
node scripts/perf/issue-5712-v2-campaign.mjs branch
node scripts/perf/issue-5712-v2-campaign.mjs recheck
node scripts/perf/issue-5712-v2-campaign.mjs final
node scripts/perf/issue-5712-v2-remote.mjs
node scripts/perf/issue-5712-v2-summary.mjs
```

Run phases sequentially. Fixture creation, builds, unit tests and profiling must finish before timing starts. The constructor refuses to overwrite a fixture, and the campaign skips completed reports; use a new disposable checkout for an independent campaign. It creates isolated synthetic data, never reads real user conversations, and uses a fake streaming backend for the remote transport checks.

`pilot` has four variants and five returns per case. `formal` has baseline and both changes, with 50 returns each for recent history, a 1,000-tool Turn, and restoring the start of 1,000 Turns. `gradient` varies tool counts, includes a giant first Turn followed by 100 regular Turns, and restores the start of 300 Turns. `extra` restores 100 Turns. `branch` restores the start of a depth-one, 300-Turn branch. `recheck` repeats 50 recent-history returns with the variant order reversed. `remote` uses three returns per idle/active and 0/+20 ms added-RTT cell, pacing the active answer against the baseline's stream age.

The recorded branch test reuses the committed 300-Turn branch from the earlier edge experiment, via `MAKA_BENCH_BRANCH_FIXTURE=artifacts/issue-5712-edge-costs/fixtures/branch-300-reopened` and `MAKA_BENCH_BRANCH_ID=979c0136-4ef7-4888-9cbc-d464aa055edc`. Without those variables, the phase creates one branch of the new 300-Turn fixture before timing. A 1,000-Turn branch creation attempt repeated the earlier unknown-outcome, CPU-bound preparation failure; it was stopped after diagnosis and produced zero return samples. Creation is a separate, unoptimized path.

The remote delay is applied to complete WebSocket frames in FIFO order, 10 ms in each direction. This is a macOS Host transport regression, not a Windows/WSL reproduction, bandwidth emulator, or loss test.

All restoration tests wait for the exact synthetic Turn ID. A return succeeds only after that target is in the viewport. The scripts observe DOM placement, opacity and animation frames, not physical compositor presentation. Process CPU and sampled RSS are recorded separately from that endpoint. Expansion samples record both the first opening and a second opening in the same component lifetime.

For attribution, close all fixture Hosts and run:

```sh
node scripts/perf/issue-5680-clone-fixture.mjs artifacts/startup-baseline/fixtures/issue5712-edge-read-20260929 artifacts/issue-5712-v2/fixtures/attribution
node scripts/perf/issue-5712-v2-attribution.mjs artifacts/issue-5712-v2/fixtures/attribution/manifest.json artifacts/issue-5712-v2/attribution
```

Its counting, CPU profiling and cancellation passes are separate; do not use those elapsed times as packaged results.

The recorded `build-identity.json` and `product-diff.json` identify the successful-path candidate measured in the formal campaign. The JSON contains the exact tracked patch and the then-untracked integration test. `verification-build-identity.json` and `verification-product-diff.json` identify the later package used by the final five-return check, the 100-Turn after result, branch, reversed-order, and remote checks. It additionally fixes navigation error recovery, releases temporary-reader cancellation listeners, validates read-acknowledgement ownership before rejecting parked-window acknowledgements, and adds regression coverage. `pilot-*` files identify the earlier four-way experiment; its corrected lazy-only restoration was rerun with the formal package. A variant's `patch=` label identifies the overall build inputs; `baseline` still restores baseline sources, and `lazy` selects only the process-mounting source change.

The final delivery is product commit `79fd458d2b07e20838e787cb75a12e6760fe9c34`. Its last change reuses an already-complete live view for export, avoiding an unnecessary detached read. `delivery-build-identity.json` verifies every recorded build input against that commit. The delivery smoke repeats middle-position recovery, downward and upward scroll paging, and returning to latest. Its raw `environment.commit` is `unknown` because the optional environment label was unset; source hashes supply its identity. The older distributions are not relabelled as measurements of the final commit. Re-running the instructions above measures the chosen final checkout, not the exact earlier candidates.

To reconstruct a recorded candidate, start from a clean disposable baseline checkout, read its `*-product-diff.json` (the formal file is `product-diff.json`), apply `trackedPatch` with `git apply`, and write each `newFiles` entry verbatim. Verify the resulting source hashes against the matching build identity, then build. Preserve the candidate's Node/Electron environment and fixture recipe. This reconstruction is only for source reproduction; it does not reproduce the original machine's background load.

The real-window delivery command, after building `both`, is:

```sh
node scripts/perf/issue-5680-clone-fixture.mjs artifacts/startup-baseline/fixtures/issue5712-edge-read-20260929 artifacts/issue-5712-v2/fixtures/delivery
node scripts/perf/issue-5712-edge-switch.mjs --manifest artifacts/issue-5712-v2/fixtures/delivery/manifest.json --output artifacts/issue-5712-v2/delivery-window --runs 1 --state idle --observe-ms 1500 --source-dwell-ms 500 --target-session-id synthetic-session-0006 --source-session-id synthetic-session-0001 --executable artifacts/issue-5712-v2/packages/both/mac-arm64/Maka.app/Contents/MacOS/Maka --restore-first --restore-index 507 --window-check --label delivery-window
```

An interrupted eight-sample run, a pilot that selected the wrong navigation tick, and a request for a nonexistent sampled tick are excluded and identified in the report. No completed slow samples are discarded. Background Spotlight/Docker activity was observed; p95 differences in small-effect cases should not be interpreted as isolated-machine causal estimates.

`summary.json` holds local per-sample metrics and distributions; `raw/` retains original report values, including the separate remote histories and content-frame milestones. `validation.json` holds the final test/check output and the expected failures from deletion ablations. `excluded/` preserves the invalid or interrupted runs and the branch-preparation diagnostic. Databases, app bundles and credentials are not committed with this evidence.
