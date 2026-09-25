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

# Running the isolated session-switch benchmarks

Use this evidence branch, which contains the product commit plus these drivers. Node 24, npm, Chromium for Playwright, and macOS Electron are required for the recorded Desktop conditions. Docker is needed for the Linux Host. All commands below run from the repository root unless noted. These scripts only accept isolated data under this checkout's `artifacts/` directory; do not point them at a user workspace.

```sh
npm ci
npm run build
mkdir -p artifacts/issue-5627
node scripts/perf/issue-5627-package.mjs artifacts/issue-5627/package
docker build -t maka-5627-host:local -f scripts/perf/issue-5627-host/Dockerfile .
```

The package is deliberately unsigned/unnotarized, uses ASAR, and omits the optional Direct peer addon. Its temporary preload probe records transcript request/batch timing and bytes. The source preload is restored in `finally`. This is a measurement package, not a release artifact.

## C: active Linux Host

Generate a recipe, then seed the database **in the Linux environment that will host it**. Directory identity must be established on that system, not imported on macOS first.

```sh
node scripts/perf/issue-5627-make-matched-recipe.mjs artifacts/issue-5627/c100.json 100 10 4096
docker run --rm -v "$PWD:$PWD" -w "$PWD" maka-5627-host:local node scripts/perf/startup-fixture.mjs --config artifacts/issue-5627/c100.json --name c100
node scripts/perf/issue-5627-matched-switch.mjs --manifest artifacts/startup-baseline/fixtures/c100/manifest.json --output artifacts/issue-5627/c100-packaged --transport remote --linux-host --delays 0,10 --runs 10 --order idle,active --executable artifacts/issue-5627/package/mac-arm64/Maka.app/Contents/MacOS/Maka
```

For scale testing use `1000 10 4096` and a different fixture/output name. For fifty-return comparisons, use `--runs 50` and collect active-only runs with `--order active`. `--pace-from path/to/baseline/report.json` matches candidate return times to baseline generation age. It does not promise identical output counters.

The driver observes one continuous FakeBackend turn through away/return, checks growing counters and UI output, and records authenticated WebSocket requests through an injected-delay proxy. `--delays 10` adds ten milliseconds in each direction. The separate control connection does not subscribe to the transcript.

## Development renderer

In another terminal, from `apps/desktop`, run:

```sh
npx vite --host 127.0.0.1 --port 5179 --strictPort
```

Run the same matched driver with `--dev-url http://127.0.0.1:5179` instead of `--executable`. Use a fresh fixture name for each independent configuration. This uses Vite with built Main/preload; it is not the original reporter's exact Windows `npm run dev` environment.

## A and B: original history shapes

```sh
node scripts/perf/startup-fixture.mjs --config scripts/perf/startup-fixtures/local-usage-v2.json --name a-local
node scripts/perf/startup-fixture.mjs --config scripts/perf/startup-fixtures/issue-5627-long-sessions-v2.json --name b-local
```

A uses target **5 turns / 789 tools** (`Fixture 0295`) and source **5 turns / 229 tools** (`Fixture 0307`). Put these two entries first and second in a copy of the A manifest's `sessionMap`, retaining all other entries and all generated absolute paths. Then run the matched driver with `--transport local --delays 0 --order idle,active`. The owned local test Host uses the same continuously observed FakeBackend. Local wire request counts are not inferred from the remote proxy.

B uses target **300 turns / 6,448 tools** and source **100 turns / 15,780 tools**. Read their generated Session IDs from the manifest and supply both explicitly; do not rely on the driver's default target, which can select the reverse direction.

```sh
node scripts/perf/issue-5627-active-switch.mjs --manifest artifacts/startup-baseline/fixtures/b-local/manifest.json --output artifacts/issue-5627/b-packaged --runs 10 --state idle --target-session-id TARGET_ID --source-session-id SOURCE_ID --observe-ms 1500 --executable artifacts/issue-5627/package/mac-arm64/Maka.app/Contents/MacOS/Maka
```

`TARGET_ID` and `SOURCE_ID` are placeholders for the synthetic IDs in that new manifest. This B package uses production local Host composition; no provider request is made. Record reverse direction separately. `--source-dwell-ms 1500` tests a longer dwell; `--observe-ms 0` removes the post-display observation interval for rapid-return checks.

Fixtures must have no running Host before copying. `issue-5680-clone-fixture.mjs SOURCE_DIR DESTINATION_DIR` clones within the current checkout and re-adopts directory identity; execute it on Linux for Linux fixtures. Do not reuse a previously generated active fixture as a fresh baseline: it contains the additional controlled Turns.

## Timing and reports

Run build, package, fixture preparation and correctness work before timing, not concurrently. Keep machine conditions and fixture shape fixed; preserve first returns, failures and reconnects. Current visual probes require the `data-placed` gate present in current main. Historical reports used the earlier DOM endpoint; keep the two definitions separate.

The matched report records pointerdown-relative `firstContentPaintAt`, `usefulContentPaintAt`, and `fadeCompletePaintAt`; the latter also requires opacity ≥0.99 and viewport intersection. B records `stablePaintMs` (legacy name for DOM anchor + double RAF) and `fadeCompletePaintMs` (placement/fade gate + double RAF). Neither is a compositor timestamp or a claim that active streaming has settled. B's final observation also includes automation polling overhead.

Aggregate completed reports using absolute report-directory arguments, for example:

```sh
MAKA_PERF_SUMMARY_PATH="$PWD/artifacts/issue-5627/summary.json" node scripts/perf/issue-5680-summarize.mjs "$PWD/artifacts/issue-5627/c100-packaged" "$PWD/artifacts/issue-5627/b-packaged"
```

p50 is the middle value or average of the middle two; p95 uses nearest rank. At n=10, p95 is the maximum. CPU intervals differ between local and active remote campaigns and must be named when compared. Before sharing reports, export only numerical samples/metrics; raw userData, credentials, wire contents, local paths and transcripts are unnecessary.

For browser correctness, build Storybook and run `node scripts/perf/issue-5680-scroll-smoke.mjs artifacts/issue-5627/scroll`. Seven selected real-layout stories must complete their `play` assertions, not merely render an image.
