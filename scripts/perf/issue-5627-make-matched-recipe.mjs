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

import { writeFile } from 'node:fs/promises';
const [output, count = '30', toolsPerTurn = '10', outputBytes = '4096'] = process.argv.slice(2);
const turn = {
  status: 'completed',
  sourceStatus: 'completed',
  items: [
    { kind: 'user', bytes: 160 },
    ...Array.from({ length: Number(toolsPerTurn) }, () => [
      { kind: 'reasoning', bytes: 128 },
      {
        kind: 'tool',
        category: 'command',
        argumentBytes: 96,
        outputBytes: Number(outputBytes),
        isError: false,
        formatHint: 'terminal',
        subtype: 'command',
      },
      { kind: 'assistant', bytes: 256 },
    ]).flat(),
    { kind: 'assistant', bytes: 512 },
  ],
};
const sessions = [1, 2].map((index) => ({
  id: `synthetic-session-000${index}`,
  projectIndex: null,
  workspaceIndex: 1,
  sourceRole: 'user-root',
  archived: false,
  pinned: true,
  parentId: null,
  isChildUnlinked: false,
  recencyRank: index - 1,
  ageMinutes: index,
  turns: Array.from({ length: Number(count) }, () => structuredClone(turn)),
}));
await writeFile(
  output,
  JSON.stringify({ schemaVersion: 2, name: 'issue-5627-matched-histories', seed: 5627, sessions }),
);
