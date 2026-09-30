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
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '../..');
const output = join(root, 'artifacts/issue-5712-v2');
const baseline = '8d73d4e237609dd784b816181a8e4cc2061a7579';
const files = execFileSync(
  'git',
  ['diff', baseline, '--name-only', '--', 'apps/desktop', 'packages/ui'],
  { cwd: root, encoding: 'utf8' },
)
  .trim()
  .split('\n')
  .filter(Boolean);
const extra = 'apps/desktop/src/main/__tests__/transcript-window.test.ts';
if (!files.includes(extra)) files.push(extra);
const sources = {};
for (const file of files) sources[file] = await readFile(join(root, file), 'utf8');
await mkdir(output, { recursive: true });
await writeFile(join(output, 'source-backup.json'), JSON.stringify(sources));
const patch = execFileSync(
  'git',
  ['diff', baseline, '--binary', '--', 'apps/desktop', 'packages/ui'],
  { cwd: root },
);
await writeFile(join(output, 'product.patch'), patch);
await writeFile(
  join(output, 'build-identity.json'),
  JSON.stringify(
    {
      baseline,
      patchSha256: createHash('sha256').update(patch).digest('hex'),
      files: Object.fromEntries(
        Object.entries(sources).map(([name, source]) => [
          name,
          createHash('sha256').update(source).digest('hex'),
        ]),
      ),
    },
    null,
    2,
  ),
);
const lazy = 'packages/ui/src/chat-turn.tsx';
const chosen = process.argv.slice(2);
async function run(command, args, log) {
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const code = await new Promise((done, reject) => {
    child.on('exit', done);
    child.on('error', reject);
  });
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} exited ${code}`);
}
try {
  for (const variant of chosen.length ? chosen : ['baseline', 'lazy', 'window', 'both']) {
    if (!['baseline', 'lazy', 'window', 'both'].includes(variant))
      throw new Error('Unknown variant');
    for (const [file, source] of Object.entries(sources)) {
      const current =
        variant === 'both' ||
        (variant === 'window' && file !== lazy) ||
        (variant === 'lazy' && file === lazy);
      await writeFile(
        join(root, file),
        current
          ? source
          : file === extra
            ? 'export {};\n'
            : execFileSync('git', ['show', `${baseline}:${file}`], { cwd: root, encoding: 'utf8' }),
      );
    }
    const log = createWriteStream(join(output, `build-${variant}.log`));
    console.log(JSON.stringify({ variant, stage: 'build', at: new Date().toISOString() }));
    try {
      await run('npm', ['--workspace', '@maka/ui', 'run', 'build'], log);
      await run('npm', ['--workspace', '@maka/desktop', 'run', 'build'], log);
      await run(
        process.execPath,
        ['scripts/perf/issue-5627-package.mjs', `artifacts/issue-5712-v2/packages/${variant}`],
        log,
      );
    } finally {
      log.end();
    }
    console.log(JSON.stringify({ variant, stage: 'complete', at: new Date().toISOString() }));
  }
} finally {
  for (const [file, source] of Object.entries(sources)) await writeFile(join(root, file), source);
}
