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
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const out = join(root, 'artifacts/issue-5712-v2');
async function run(script, args, path) {
  const log = createWriteStream(path);
  const child = spawn(process.execPath, [join(root, script), ...args], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const code = await new Promise((done) => child.on('exit', done));
  log.end();
  if (code !== 0) throw new Error(`${script}: ${code}; see ${path}`);
}
for (const variant of ['baseline', 'both']) {
  const fixture = join(out, 'fixtures', `remote-${variant}`);
  if (
    !(await readFile(join(fixture, 'manifest.json')).then(
      () => true,
      () => false,
    ))
  ) {
    await run(
      'scripts/perf/issue-5680-clone-fixture.mjs',
      ['artifacts/startup-baseline/fixtures/issue5712-edge-read-20260929', fixture],
      join(out, `clone-remote-${variant}.log`),
    );
  }
  const manifest = JSON.parse(await readFile(join(fixture, 'manifest.json'), 'utf8'));
  const target = manifest.sessionMap.find((s) => s.syntheticId === 'synthetic-session-0002');
  const source = manifest.sessionMap.find((s) => s.syntheticId === 'synthetic-session-0001');
  if (!target || !source) throw new Error('Matched fixture entries not found');
  manifest.sessionMap = [
    target,
    source,
    ...manifest.sessionMap.filter((s) => s !== target && s !== source),
  ];
  const manifestPath = join(fixture, 'remote-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const destination = join(out, `remote-${variant}`);
  const previous = await readFile(join(destination, 'report.json'), 'utf8').then(
    JSON.parse,
    () => null,
  );
  if (previous?.ok) continue;
  await mkdir(destination, { recursive: true });
  console.log(JSON.stringify({ variant, stage: 'remote-begin', at: new Date().toISOString() }));
  await run(
    'scripts/perf/issue-5627-matched-switch.mjs',
    [
      '--manifest',
      manifestPath,
      '--output',
      destination,
      '--runs',
      '3',
      '--transport',
      'remote',
      '--delays',
      '0,10',
      '--order',
      'idle,active',
      '--settle-window-ms',
      '1500',
      '--label',
      `v2-remote-${variant}`,
      '--executable',
      join(out, `packages/${variant}/mac-arm64/Maka.app/Contents/MacOS/Maka`),
      ...(variant === 'both' ? ['--pace-from', join(out, 'remote-baseline/report.json')] : []),
    ],
    join(destination, 'run.log'),
  );
  const report = JSON.parse(await readFile(join(destination, 'report.json'), 'utf8'));
  console.log(JSON.stringify({ variant, ok: report.ok, samples: report.samples.length }));
}
