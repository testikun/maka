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
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const out = join(root, 'artifacts/issue-5712-v2');
const phase = process.argv[2] ?? 'pilot';
const identity = JSON.parse(await readFile(join(out, 'build-identity.json'), 'utf8'));
const branchFixture = process.env.MAKA_BENCH_BRANCH_FIXTURE;
const branchId = process.env.MAKA_BENCH_BRANCH_ID;
if (Boolean(branchFixture) !== Boolean(branchId))
  throw new Error('An existing branch requires its fixture and ID');
const variants =
  phase === 'pilot'
    ? ['baseline', 'lazy', 'window', 'both']
    : phase === 'final'
      ? ['both']
      : phase === 'recheck'
        ? ['both', 'baseline']
        : ['baseline', 'both'];
const cases =
  phase === 'branch'
    ? [
        [
          'branch-restore-300',
          branchFixture ? '0009' : '0016',
          [
            ...(branchId ? ['--existing-branch-id', branchId] : ['--branch-depth', '1']),
            '--restore-first',
          ],
        ],
      ]
    : phase === 'recheck'
      ? [['tail-1000', '0006', []]]
      : phase === 'extra'
        ? [['restore-100', '0002', ['--restore-first']]]
        : phase === 'gradient'
          ? [
              ...[10, 11, 12, 13].map((suffix, i) => [
                `tools-${[10, 50, 100, 300][i]}`,
                String(suffix).padStart(4, '0'),
                ['--expand-process'],
              ]),
              ['combined-giant-first', '0015', ['--restore-first', '--expand-process']],
              ['restore-300', '0016', ['--restore-first']],
            ]
          : [
              ['tail-1000', '0006', []],
              ['giant-1000', '0003', ['--expand-process']],
              ['restore-1000', '0006', ['--restore-first']],
            ];
async function run(script, args, logPath, variant) {
  const log = createWriteStream(logPath);
  const child = spawn(process.execPath, [join(root, script), ...args], {
    cwd: root,
    env: {
      ...process.env,
      MAKA_BENCH_COMMIT: `${identity.baseline};${variant};patch=${identity.patchSha256}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const code = await new Promise((done) => child.on('exit', done));
  log.end();
  if (code !== 0) throw new Error(`${script}: ${code}; see ${logPath}`);
}
const jobs =
  phase === 'formal'
    ? cases.flatMap((entry) => variants.map((variant) => [variant, entry]))
    : variants.flatMap((variant) => cases.map((entry) => [variant, entry]));
for (const [variant, [name, target, extra]] of jobs) {
  const fixture = join(out, 'fixtures', `${phase}-${variant}`);
  if (
    !(await readFile(join(fixture, 'manifest.json')).then(
      () => true,
      () => false,
    ))
  ) {
    await run(
      'scripts/perf/issue-5680-clone-fixture.mjs',
      [
        phase === 'branch' && branchFixture
          ? branchFixture
          : ['gradient', 'branch'].includes(phase)
            ? 'artifacts/startup-baseline/fixtures/issue5712-v2-gradients-20260930'
            : 'artifacts/startup-baseline/fixtures/issue5712-edge-read-20260929',
        fixture,
      ],
      join(out, `clone-${phase}-${variant}.log`),
      variant,
    );
  }
  const destination = join(out, `${phase}-${variant}-${name}`);
  const previous = await readFile(join(destination, 'report.json'), 'utf8').then(
    JSON.parse,
    () => null,
  );
  if (
    previous?.ok &&
    (!extra.includes('--restore-first') ||
      previous.edge?.anchor === `synthetic-session-${target}_t0_turn`)
  )
    continue;
  await mkdir(destination, { recursive: true });
  console.log(
    JSON.stringify({ phase, variant, name, stage: 'begin', at: new Date().toISOString() }),
  );
  await run(
    'scripts/perf/issue-5712-edge-switch.mjs',
    [
      '--manifest',
      join(fixture, 'manifest.json'),
      '--output',
      destination,
      '--runs',
      ['formal', 'recheck'].includes(phase) ? '50' : '5',
      '--state',
      'idle',
      '--observe-ms',
      '1500',
      '--source-dwell-ms',
      '500',
      '--target-session-id',
      `synthetic-session-${target}`,
      '--source-session-id',
      'synthetic-session-0001',
      '--executable',
      join(out, `packages/${variant}/mac-arm64/Maka.app/Contents/MacOS/Maka`),
      '--label',
      `${phase}-${variant}-${name}`,
      ...extra,
      ...(phase === 'final' && name === 'tail-1000' ? ['--first-access', '--first-input'] : []),
    ],
    join(destination, 'run.log'),
    variant,
  );
  const report = JSON.parse(await readFile(join(destination, 'report.json'), 'utf8'));
  const times = report.samples.idle.map((s) => s.fadeCompletePaintMs).sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      phase,
      variant,
      name,
      ok: report.ok,
      n: times.length,
      p50: (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2,
      bytes: report.samples.idle[0]?.transcript.bytes,
      pages: report.samples.idle[0]?.pages.length,
    }),
  );
}
