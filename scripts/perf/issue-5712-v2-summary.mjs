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
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '../../artifacts/issue-5712-v2');
const round = (x) => Math.round(x * 1000) / 1000;
const stats = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length
    ? {
        n: s.length,
        p50: round((s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2),
        ...(s.length >= 50 ? { p95: round(s[Math.ceil(s.length * 0.95) - 1]) } : {}),
        min: round(s[0]),
        max: round(s.at(-1)),
        first: round(xs[0]),
      }
    : null;
};
const ps = (s) => {
  const [time, rss] = s.trim().split(/\s+/);
  return {
    cpu: time.split(':').reduce((sum, n) => sum * 60 + Number(n), 0),
    rssMiB: Number(rss) / 1024,
  };
};
function cpu(before, after) {
  return {
    host: round(ps(after.host).cpu - ps(before.host).cpu),
    main: round(ps(after.main).cpu - ps(before.main).cpu),
    renderer: round(
      after.chromium.processInfo
        .filter((p) => p.type === 'renderer')
        .reduce(
          (sum, p) =>
            sum +
            p.cpuTime -
            (before.chromium.processInfo.find((q) => p.id === q.id)?.cpuTime ?? p.cpuTime),
          0,
        ),
    ),
  };
}
const result = {
  timingEndpoint:
    'Real pointerdown to target DOM in viewport, opacity >= .99 and double RAF; not physical pixels or complete layout stability.',
  resourceWindow:
    'switch CPU ends at visible assertion; cycle CPU includes source switch, 500 ms dwell, expansion checks if present, and 1500 ms post-display observation.',
  cases: [],
  excluded: [],
};
for (const name of (await readdir(root)).sort()) {
  const r = await readFile(join(root, name, 'report.json'), 'utf8').then(JSON.parse, () => null);
  if (!r?.samples?.idle?.length) continue;
  if (
    !r.ok ||
    (r.edge?.restoreFirst && !r.edge?.anchor?.endsWith(`_t${r.edge.restoreIndex ?? 0}_turn`))
  ) {
    result.excluded.push({ name, reason: r.error ?? 'wrong anchor or incomplete run' });
    continue;
  }
  const samples = r.samples.idle.map((s) => {
    const { before, after, cycleBefore, observedAfter, memorySamples = [] } = s.resources;
    const phases = cpu(before, after),
      cycle = cpu(cycleBefore, observedAfter);
    const renderers = before.chromium.processInfo
      .filter((p) => p.type === 'renderer')
      .map((p) => p.id);
    const peaks = { host: ps(before.host).rssMiB, main: ps(before.main).rssMiB, renderer: 0 };
    for (const sample of memorySamples) {
      const values = { host: 0, main: 0, renderer: 0 };
      for (const line of sample.rows.split('\n')) {
        const [pid, rss] = line.trim().split(/\s+/).map(Number);
        if (pid === r.hostRegistration.pid) values.host += rss / 1024;
        else if (renderers.includes(pid)) values.renderer += rss / 1024;
        else values.main += rss / 1024;
      }
      for (const key in peaks) peaks[key] = Math.max(peaks[key], values[key]);
    }
    const ready = (s.transcriptAttempts ?? [])
      .flatMap((a) => a.batches)
      .filter((b) => b.ready)
      .map((b) => b.at);
    return {
      run: s.run,
      visibleMs: s.fadeCompletePaintMs,
      readyMs: s.transcript.readyBatchMs,
      rangeReadyMs: ready.length ? Math.max(...ready) : s.transcript.readyBatchMs,
      bytes: s.transcript.bytes,
      pages: s.pages.length,
      loadedTurns: s.anchorViewport.loadedTurns,
      firstExpandMs: s.expansion?.[0]?.ms,
      reopenMs: s.expansion?.[1]?.ms,
      hiddenNodes: s.expansion?.[0]?.before,
      expandedNodes: s.expansion?.[0]?.after,
      ...Object.fromEntries(Object.entries(phases).map(([k, v]) => [`${k}CpuSeconds`, v])),
      ...Object.fromEntries(Object.entries(cycle).map(([k, v]) => [`cycle${k}CpuSeconds`, v])),
      ...Object.fromEntries(Object.entries(peaks).map(([k, v]) => [`${k}PeakMiB`, round(v)])),
    };
  });
  const metrics = Object.fromEntries(
    Object.keys(samples[0])
      .filter((key) => key !== 'run')
      .map((key) => [key, stats(samples.map((s) => s[key]))]),
  );
  result.cases.push({
    name,
    build: r.environment.commit,
    target: r.fixture.target,
    edge: r.edge,
    windowChecks: r.windowChecks,
    metrics,
    samples,
  });
}
await writeFile(join(root, 'summary.json'), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify(
    result.cases.map((c) => ({
      name: c.name,
      visible: c.metrics.visibleMs,
      pages: c.metrics.pages.p50,
      bytes: c.metrics.bytes.p50,
      expand: c.metrics.firstExpandMs?.p50,
      hostCpu: c.metrics.hostCpuSeconds.p50,
      rendererCpu: c.metrics.rendererCpuSeconds.p50,
    })),
    null,
    2,
  ),
);
