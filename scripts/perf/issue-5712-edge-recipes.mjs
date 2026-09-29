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
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve(import.meta.dirname, '../../artifacts/issue-5712-edge-costs');
await mkdir(output, { recursive: true });
const shapes = [
  ['source', 2, 1, 4096],
  ['split-1000-tools', 100, 10, 4096],
  ['giant-1000-tools', 1, 1000, 4096],
  ['split-4000-tools', 400, 10, 4096],
  ['giant-4000-tools', 1, 4000, 4096],
  ['history-1000-turns', 1000, 10, 4096],
  ['giant-single-output', 1, 1, 4 * 1024 * 1024],
];
const sessions = shapes.map(([label, turns, tools, outputBytes], index) => ({
  id: `synthetic-session-${String(index + 1).padStart(4, '0')}`,
  projectIndex: null, workspaceIndex: 1, sourceRole: 'user-root',
  archived: false, pinned: true, parentId: null, isChildUnlinked: false,
  recencyRank: index, ageMinutes: index + 1,
  turns: Array.from({ length: turns }, () => ({
    status: 'completed', sourceStatus: 'completed',
    items: [
      { kind: 'user', bytes: 160 },
      ...Array.from({ length: tools }, () => [
        { kind: 'reasoning', bytes: 128 },
        { kind: 'tool', category: 'command', argumentBytes: 96, outputBytes,
          isError: false, formatHint: 'terminal', subtype: 'command' },
        { kind: 'assistant', bytes: 256 },
      ]).flat(),
      { kind: 'assistant', bytes: 512 },
    ],
  })),
}));
await writeFile(`${output}/recipe.json`, JSON.stringify({
  schemaVersion: 2, name: 'issue-5712-edge-costs', seed: 5712, sessions,
}));
await writeFile(`${output}/recipe-read-costs.json`, JSON.stringify({
  schemaVersion: 2, name: 'issue-5712-edge-read-costs', seed: 5712,
  sessions: sessions.filter((s) => !['synthetic-session-0004', 'synthetic-session-0005'].includes(s.id)),
}));
await writeFile(`${output}/shape-map.json`, JSON.stringify(shapes.map(([label, turns, toolsPerTurn, outputBytes], index) => ({
  label, syntheticId: sessions[index].id, turns, toolsPerTurn, outputBytes,
})), null, 2));
await writeFile(`${output}/recipe-assistant-4m.json`, JSON.stringify({
  schemaVersion: 2, name: 'issue-5712-single-assistant-message', seed: 5712,
  sessions: [sessions[0], { ...sessions[1], id: 'synthetic-session-0008', turns: [{
    status: 'completed', sourceStatus: 'completed',
    items: [{ kind: 'user', bytes: 160 }, { kind: 'assistant', bytes: 4 * 1024 * 1024 }],
  }] }, { ...sessions[1], id: 'synthetic-session-0009',
    turns: Array.from({ length: 300 }, () => structuredClone(sessions[1].turns[0])),
  }],
}));
