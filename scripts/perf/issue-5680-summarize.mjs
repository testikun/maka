/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../artifacts/issue-5680');
const round = (n) => Math.round(n * 1000) / 1000;
function statistics(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  return {
    n: xs.length,
    p50: round((xs[Math.floor((xs.length - 1) / 2)] + xs[Math.floor(xs.length / 2)]) / 2),
    p95: round(xs[Math.ceil(xs.length * 0.95) - 1]),
    min: round(xs[0]),
    max: round(xs.at(-1)),
  };
}
function cpuDelta(before, after, type, electron = false) {
  const key = electron ? 'pid' : 'id';
  const cpu = (p) => (electron ? p.cpu.cumulativeCPUUsage : p.cpuTime);
  return after
    .filter((p) => !type || p.type === type)
    .reduce((n, p) => {
      const start = before.find((b) => b[key] === p[key]);
      assert(start, 'process changed inside resource interval');
      return n + cpu(p) - cpu(start);
    }, 0);
}
function psResource(text) {
  const [time, rss] = text.trim().split(/\s+/);
  return { cpu: time.split(':').reduce((n, v) => n * 60 + Number(v), 0), rss: Number(rss) / 1024 };
}
function bRow(sample, report) {
  const { before, after } = sample.resources;
  const startHost = psResource(before.host);
  const endHost = psResource(after.host);
  const cycle = sample.resources.cycleBefore;
  const observed = sample.resources.observedAfter;
  const memory = sample.resources.memorySamples ?? [];
  const pidPeak = (pid) =>
    Math.max(
      ...memory.flatMap((s) =>
        s.rows.split('\n').flatMap((line) => {
          const [id, rss] = line.trim().split(/\s+/).map(Number);
          return id === pid ? [rss / 1024] : [];
        }),
      ),
    );
  const hostPid = report.hostRegistration.pid;
  const rendererPids =
    cycle?.chromium.processInfo.filter((p) => p.type === 'renderer').map((p) => p.id) ?? [];
  if (cycle) {
    assert(observed && memory.length > 0, 'missing full-cycle observation');
    assert(
      memory.every((entry) => !entry.error),
      'failed RSS sample',
    );
    assert(Number.isFinite(pidPeak(hostPid)), 'missing Host RSS samples');
  }
  return {
    run: sample.run,
    oldGoneMs: sample.oldTranscriptGoneMs,
    firstTargetMs: sample.firstTargetTurnVisibleMs,
    // The older harness calls this stablePaintMs. It is anchor + double RAF,
    // not proof of layout stability, and is labelled accordingly here.
    contentFrameMs: sample.stablePaintMs,
    fadeCompleteFrameMs: sample.fadeCompletePaintMs,
    openMs: sample.transcript.openCalledMs,
    firstBatchMs: sample.transcript.firstBatchMs,
    readyMs: sample.transcript.readyBatchMs,
    openToFirstBatchMs: sample.transcript.firstBatchMs - sample.transcript.openCalledMs,
    firstBatchToReadyMs: sample.transcript.readyBatchMs - sample.transcript.firstBatchMs,
    rendererBytes: sample.transcript.bytes,
    batches: sample.transcript.batches,
    handlerMs: sample.transcript.handlerMs,
    hostCpuSeconds: endHost.cpu - startHost.cpu,
    mainCpuSeconds: cpuDelta(before.chromium.processInfo, after.chromium.processInfo, 'browser'),
    rendererCpuSeconds: cpuDelta(
      before.chromium.processInfo,
      after.chromium.processInfo,
      'renderer',
    ),
    hostEndRssMiB: endHost.rss,
    mainEndRssMiB: psResource(after.main).rss,
    resourceIntervalMs: after.at - before.at,
    ...(cycle && observed
      ? {
          cycleWallMs: observed.at - cycle.at,
          cycleHostCpuSeconds: psResource(observed.host).cpu - psResource(cycle.host).cpu,
          cycleDesktopCpuSeconds: cpuDelta(
            cycle.chromium.processInfo,
            observed.chromium.processInfo,
          ),
          cycleAllCpuSeconds:
            psResource(observed.host).cpu -
            psResource(cycle.host).cpu +
            cpuDelta(cycle.chromium.processInfo, observed.chromium.processInfo),
          postDisplayHostCpuSeconds: psResource(observed.host).cpu - endHost.cpu,
          hostObservedRssMiB: psResource(observed.host).rss,
          hostPeakSampledRssMiB: pidPeak(hostPid),
          rendererPeakSampledRssMiB: Math.max(
            ...memory.map((s) =>
              s.rows.split('\n').reduce((n, line) => {
                const [id, rss] = line.trim().split(/\s+/).map(Number);
                return n + (rendererPids.includes(id) ? rss / 1024 : 0);
              }, 0),
            ),
          ),
        }
      : {}),
  };
}
function cRow(sample, report) {
  const { beforeAway, beforeReturn, afterReturn } = sample.activeEvidence;
  if (sample.state === 'active') {
    assert(beforeAway && beforeReturn && afterReturn);
    assert(!beforeAway.endedAt && !beforeReturn.endedAt && !afterReturn.endedAt);
    assert.equal(beforeAway.turnId, beforeReturn.turnId);
    assert.equal(beforeReturn.turnId, afterReturn.turnId);
    assert(beforeAway.deltas < beforeReturn.deltas && beforeReturn.deltas < afterReturn.deltas);
    assert(Number.isFinite(sample.times.liveAdvancedAt));
    assert(
      Number.isFinite(sample.times.usefulContentPaintAt),
      'missing useful frame; do not silently filter samples',
    );
    assert(
      sample.loadedHistoryCountAtFirstUseful > 1,
      'fixture useful frame needs history beyond its one active Turn',
    );
  }
  const traces = sample.transcript.filter((t) => t.sessionId === report.targetId);
  const batches = traces.flatMap((t) => t.batches);
  const ready = batches.find((b) => b.ready);
  assert(ready, 'missing ready transcript batch');
  assert.equal(ready.hostEpoch, report.host.hostEpoch);
  const requests = sample.returnWire.filter((f) => f.direction === 'to-host');
  const subscriptions = requests.filter(
    (f) =>
      f.operation === 'subscription.open' && f.sessionId === report.fixture.sessions[0].sessionId,
  );
  const remote = report.environment.transport === 'remote';
  if (remote) assert.equal(subscriptions.length, sample.state === 'active' ? 0 : 1);
  const pages = requests.filter((f) => f.operation === 'session.transcript.page');
  if (remote) assert(pages.length > 0);
  const ipc = batches.flatMap((b) => {
    const sent = sample.main.find(
      (m) => m.generation === b.generation && m.deliverySequence === b.deliverySequence,
    );
    return sent ? [b.at - sent.at] : [];
  });
  const { beforeReturn: start, afterReturn: end } = sample.resources;
  const hostCpu = (s) => (s.host.cpu.user + s.host.cpu.system) / 1e6;
  const rss = (type) =>
    end.desktop
      .filter((p) => p.type === type)
      .reduce((n, p) => n + p.memory.workingSetSize / 1024, 0);
  return {
    run: sample.run,
    oldGoneMs: sample.times.oldGoneAt,
    firstTargetMs: sample.times.firstHistoryAt,
    contentFrameMs: sample.times.firstContentPaintAt,
    usefulContentFrameMs: sample.times.usefulContentPaintAt,
    fadeCompleteFrameMs: sample.times.fadeCompletePaintAt,
    liveAdvanceMs: sample.times.liveAdvancedAt,
    historySettledMs: sample.times.historySettledAt,
    openMs: traces[0].openedAt - sample.startAt,
    firstBatchMs: batches[0].at - sample.startAt,
    readyMs: ready.at - sample.startAt,
    firstBatchToReadyMs: ready.at - batches[0].at,
    openResolvedMs: traces[0].resolvedAt - sample.startAt,
    ipcMedianMs: statistics(ipc)?.p50,
    ipcMaxMs: statistics(ipc)?.max,
    handlerMs: batches.reduce((n, b) => n + b.handledAt - b.at, 0),
    rendererBytes: batches.reduce((n, b) => n + b.bytes, 0),
    batches: batches.length,
    pageRequests: remote ? pages.length : undefined,
    targetSubscriptions: remote ? subscriptions.length : undefined,
    hostPageResponseBytes: remote
      ? sample.returnWire
          .filter((f) => f.direction === 'to-desktop' && f.operation === 'session.transcript.page')
          .reduce((n, f) => n + f.bytes, 0)
      : undefined,
    hostCpuSeconds: hostCpu(end) - hostCpu(start),
    mainCpuSeconds: cpuDelta(start.desktop, end.desktop, 'Browser', true),
    rendererCpuSeconds: cpuDelta(start.desktop, end.desktop, 'Tab', true),
    hostEndRssMiB: end.host.memory.rss / 1024 ** 2,
    mainEndRssMiB: rss('Browser'),
    rendererEndRssMiB: rss('Tab'),
    liveAgeMs: beforeReturn
      ? sample.startAt + report.hostClock.hostMinusClientMs - beforeReturn.startedAt
      : null,
    liveDeltasAtReturn: beforeReturn?.deltas,
  };
}

const output = [];
for (const name of process.argv.slice(2)) {
  const path = resolve(root, name, 'report.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  assert(report.ok, `${name} is incomplete or failed`);
  if (name.startsWith('b-original-')) {
    assert.equal(report.fixture.target.sessionId, 'f3d53e38-5d24-46bc-890e-cc0f8fbbd3be');
    assert.equal(report.fixture.source.sessionId, 'f52ba788-c6b0-4d0a-bdbd-2f934fada4ae');
  }
  const groups = new Map();
  if (Array.isArray(report.samples)) {
    for (const sample of report.samples) {
      const condition = `${sample.state}/rtt${sample.addedRttMs}`;
      if (!groups.has(condition)) groups.set(condition, []);
      groups.get(condition).push(cRow(sample, report));
    }
  } else {
    for (const [state, samples] of Object.entries(report.samples)) {
      if (samples.length)
        groups.set(
          state,
          samples.map((sample) => bRow(sample, report)),
        );
    }
  }
  for (const [condition, samples] of groups) {
    const keys = [...new Set(samples.flatMap(Object.keys))].filter((k) => k !== 'run');
    const metrics = Object.fromEntries(keys.map((k) => [k, statistics(samples.map((s) => s[k]))]));
    const fixture = Array.isArray(report.fixture.sessions)
      ? report.fixture.sessions.map(({ sessionId, name, turns, tools }) => ({
          sessionId,
          name,
          turns,
          tools,
        }))
      : { target: report.fixture.target, source: report.fixture.source };
    const row = { name, path, fixture, condition, n: samples.length, metrics, samples };
    output.push(row);
    console.log(JSON.stringify({ name, condition, n: samples.length, metrics }));
  }
}
await writeFile(
  resolve(root, process.env.MAKA_PERF_SUMMARY_PATH ?? 'performance-summary.json'),
  `${JSON.stringify(output, null, 2)}\n`,
);
