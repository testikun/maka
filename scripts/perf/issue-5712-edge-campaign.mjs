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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const output = join(root, 'artifacts/issue-5712-edge-costs');
const fixture = join(root, 'artifacts/startup-baseline/fixtures/issue5712-edge-read-20260929');
const executable = join(output, 'package/mac-arm64/Maka.app/Contents/MacOS/Maka');
const cases = [
  ['root-100', '0002', []],
  ['giant-1000', '0003', []],
  ['single-output-4m', '0007', []],
  ['root-1000', '0006', []],
  ['branch-100', '0002', ['--branch-depth', '1']],
  ['branch-1000', '0006', ['--branch-depth', '1']],
  ['restore-100', '0002', ['--restore-first']],
  ['restore-1000', '0006', ['--restore-first']],
  ['assistant-4m', '0008', [], 'issue5712-assistant-4m-20260929'],
  ['root-300', '0009', [], 'issue5712-assistant-4m-20260929'],
  ['branch-300', '0009', ['--branch-depth', '1'], 'issue5712-assistant-4m-20260929'],
];
const selected = process.argv[2];
const runs = process.argv[3] ?? '5';
const tag = process.argv[4] ?? '';
const campaign = [];
async function execute(script, args, logPath) {
  const log = createWriteStream(logPath);
  const child = spawn(process.execPath, [join(root, script), ...args], {
    cwd: root, env: { ...process.env, MAKA_BENCH_COMMIT: '5017c7534780f21fef65ab13a93c92c95ce16a3e' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log); child.stderr.pipe(log);
  const code = await new Promise((done) => child.on('exit', done));
  log.end();
  return code;
}
for (const [name, suffix, extra, fixtureName] of cases) {
  if (selected && name !== selected) continue;
  const caseOutput = join(output, name + tag);
  const clone = join(output, 'fixtures', name + tag);
  await mkdir(caseOutput, { recursive: true });
  console.log(JSON.stringify({ stage: 'begin', name, at: new Date().toISOString() }));
  const sourceFixture = fixtureName ? join(root, 'artifacts/startup-baseline/fixtures', fixtureName) : fixture;
  const cloneCode = await execute('scripts/perf/issue-5680-clone-fixture.mjs', [sourceFixture, clone], join(caseOutput, 'clone.log'));
  if (cloneCode !== 0) throw new Error(`Cannot clone ${name}`);
  const code = await execute('scripts/perf/issue-5712-edge-switch.mjs', [
    '--manifest', join(clone, 'manifest.json'), '--output', caseOutput,
    '--runs', runs, '--state', 'idle', '--observe-ms', '1500', '--source-dwell-ms', '500',
    '--target-session-id', `synthetic-session-${suffix}`, '--source-session-id', 'synthetic-session-0001',
    '--executable', executable, '--label', name, ...extra,
  ], join(caseOutput, 'run.log'));
  const report = await readFile(join(caseOutput, 'report.json'), 'utf8').then(JSON.parse, () => null);
  const entry = { name, code, ok: report?.ok, error: report?.error,
    samples: report?.samples?.idle?.map((s) => ({ run:s.run, visibleMs:s.fadeCompletePaintMs,
      readyMs:s.transcript.readyBatchMs, bytes:s.transcript.bytes, pages:s.pages?.length, anchor:s.anchorViewport })) };
  campaign.push(entry);
  await writeFile(join(output, `campaign${selected ? '-'+selected : ''}.json`), JSON.stringify(campaign, null, 2));
  console.log(JSON.stringify({ stage: 'complete', ...entry }));
}
