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
import { readFile, writeFile } from 'node:fs/promises';
const base = JSON.parse(
  await readFile(
    new URL('../../artifacts/issue-5712-edge-costs/recipe.json', import.meta.url),
    'utf8',
  ),
);
const source = base.sessions[0],
  regular = base.sessions[1].turns[0],
  giant = base.sessions[2].turns[0];
const sessions = [
  source,
  ...[10, 50, 100, 300].map((tools, index) => ({
    ...base.sessions[2],
    id: `synthetic-session-${String(index + 10).padStart(4, '0')}`,
    recencyRank: index + 1,
    turns: [
      {
        ...giant,
        items: [giant.items[0], ...giant.items.slice(1, 1 + tools * 3), giant.items.at(-1)],
      },
    ],
  })),
  {
    ...base.sessions[2],
    id: 'synthetic-session-0015',
    recencyRank: 5,
    turns: [giant, ...Array.from({ length: 100 }, () => regular)],
  },
  {
    ...base.sessions[1],
    id: 'synthetic-session-0016',
    recencyRank: 6,
    turns: Array.from({ length: 300 }, () => regular),
  },
];
await writeFile(
  new URL('../../artifacts/issue-5712-v2/gradient-recipe.json', import.meta.url),
  JSON.stringify({
    schemaVersion: 2,
    name: 'issue-5712-v2-gradients',
    seed: 5712,
    sessions,
  }),
);
