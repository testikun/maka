#!/usr/bin/env node
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
import { gzipSync, gunzipSync } from 'node:zlib';

const input = resolve(process.argv[2] ?? 'scripts/perf/startup-fixtures/local-usage-v2.json');
const output = resolve(
  process.argv[3] ?? 'scripts/perf/startup-fixtures/issue-5627-long-sessions-v2.json',
);
assert.notEqual(input, output, 'Input and output recipes must differ');

const bytes = await readFile(input);
const config = JSON.parse((input.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
assert.equal(config.schemaVersion, 2);

const expansions = [
  { id: 'synthetic-session-0295', turns: 100, ageMinutes: 1 },
  { id: 'synthetic-session-0238', turns: 300, ageMinutes: 0 },
];

for (const expansion of expansions) {
  const session = config.sessions.find(({ id }) => id === expansion.id);
  assert(session, `Missing source session ${expansion.id}`);
  assert.equal(session.archived, false);
  assert.equal(session.parentId, null);
  const sourceTurns = structuredClone(session.turns);
  assert(sourceTurns.length > 0);
  assert.equal(
    sourceTurns.some((turn) => turn.items.some((item) => item.childIds?.length)),
    false,
    'A repeated source turn must not contain child lineage references',
  );
  session.turns = Array.from({ length: expansion.turns }, (_, index) =>
    structuredClone(sourceTurns[index % sourceTurns.length]),
  );
  session.ageMinutes = expansion.ageMinutes;
}

await writeFile(
  output,
  output.endsWith('.gz')
    ? gzipSync(JSON.stringify(config), { level: 9 })
    : JSON.stringify(config) + '\n',
);
console.log(JSON.stringify({ output, expansions }, null, 2));
