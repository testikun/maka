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
import { createHash } from 'node:crypto';
import { buildShapeScenario } from './startup-shaped-scenario.mjs';

// Pure, source-independent workload constructor. No filesystem, Codex reader,
// provider, wall clock, or original user content is available to this module.
export function buildScenario(config) {
  if (config.schemaVersion === 2) return buildShapeScenario(config);
  assert.equal(config.schemaVersion, 1, 'Unsupported scenario schema');
  const random = seededRandom(config.seed);
  const shuffle = (items) => {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  };
  const turnCounts = shuffle(expandCounts(config.sessionTurnHistogram, 'sessions', 'turns'));
  const totalSessions = turnCounts.length;
  assert(totalSessions > 0 && totalSessions <= 100000, 'Invalid session total');
  const archived = integer(config.archivedSessions),
    childCount = integer(config.childSessions),
    pinned = integer(config.pinnedSessions ?? 0);
  assert(
    archived < totalSessions && childCount < totalSessions && pinned <= totalSessions - archived,
    'Invalid session state counts',
  );
  const projectSlots = shuffle(
    config.projectSessionCounts.flatMap((count, index) => Array(integer(count)).fill(index + 1)),
  );
  assert(projectSlots.length <= totalSessions, 'Project assignments exceed sessions');
  projectSlots.push(...Array(totalSessions - projectSlots.length).fill(null));
  shuffle(projectSlots);
  const turnProfiles = shuffle(
    config.turnWorkHistogram.flatMap((shape) =>
      Array.from({ length: integer(shape.count) }, () => ({
        userCount: integer(shape.user),
        assistantCount: integer(shape.assistant),
        reasoningCount: integer(shape.reasoning),
        toolCount: integer(shape.tools),
      })),
    ),
  );
  assert.equal(
    turnProfiles.length,
    turnCounts.reduce((a, b) => a + b, 0),
    'Turn histogram and workload count disagree',
  );
  const statuses = shuffle(expandCounts(config.turnStatusCounts, 'count', 'status', false));
  assert.equal(statuses.length, turnProfiles.length, 'Turn status count mismatch');
  assert(
    statuses.every((status) => ['completed', 'failed', 'aborted'].includes(status)),
    'V1 supports settled histories only',
  );
  const tools = shuffle(
    Object.entries(config.toolKindCounts).flatMap(([kind, count]) =>
      Array(integer(count)).fill(kind),
    ),
  );
  assert(
    tools.every((kind) =>
      ['command', 'read', 'search', 'edit', 'mcp', 'delegate', 'image', 'web'].includes(kind),
    ),
    'Unknown synthetic tool category',
  );
  assert.equal(
    tools.length,
    turnProfiles.reduce((n, t) => n + t.toolCount, 0),
    'Tool count mismatch',
  );
  const byteLists = {};
  for (const [kind, bins] of Object.entries(config.byteHistograms)) {
    byteLists[kind] = shuffle(
      bins.flatMap((bin) => {
        const count = integer(bin.count),
          total = integer(bin.totalBytes);
        assert(count > 0 || total === 0, 'Nonzero bytes with empty bucket');
        if (bin.upperBytes !== undefined) {
          integer(bin.upperBytes);
          assert(
            count === 0 || Math.ceil(total / count) <= bin.upperBytes,
            'Bucket total exceeds its declared upper bound',
          );
        }
        assert(
          count === 0 || Math.ceil(total / count) <= 16 * 1024 * 1024,
          'A generated item exceeds the supported 16 MiB fixture limit',
        );
        return Array.from(
          { length: count },
          (_, i) => Math.floor(total / count) + Number(i < total % count),
        );
      }),
    );
  }
  for (const [kind, field] of [
    ['user', 'userCount'],
    ['assistant', 'assistantCount'],
    ['reasoning', 'reasoningCount'],
    ['toolArguments', 'toolCount'],
    ['toolOutputs', 'toolCount'],
  ]) {
    assert.equal(
      byteLists[kind]?.length,
      turnProfiles.reduce((n, t) => n + t[field], 0),
      `${kind} byte count mismatch`,
    );
  }
  const offsets = Object.fromEntries(Object.keys(byteLists).map((key) => [key, 0]));
  const take = (kind, count) => {
    const start = offsets[kind];
    offsets[kind] += count;
    return byteLists[kind].slice(start, start + count);
  };
  let turnOffset = 0,
    toolOffset = 0;
  const sessions = turnCounts.map((count, index) => ({
    id: `synthetic-session-${String(index + 1).padStart(4, '0')}`,
    projectIndex: projectSlots[index],
    workspaceIndex: 0,
    archived: false,
    pinned: false,
    parentId: null,
    ageMinutes: index,
    turns: Array.from({ length: count }, () => {
      const shape = turnProfiles[turnOffset],
        status = statuses[turnOffset++];
      const argumentSizes = take('toolArguments', shape.toolCount),
        outputSizes = take('toolOutputs', shape.toolCount);
      return {
        status,
        user: take('user', shape.userCount),
        assistant: take('assistant', shape.assistantCount),
        reasoning: take('reasoning', shape.reasoningCount),
        tools: Array.from({ length: shape.toolCount }, (_, i) => ({
          kind: tools[toolOffset++],
          argumentBytes: argumentSizes[i],
          outputBytes: outputSizes[i],
        })),
      };
    }),
  }));
  const groups = new Map();
  for (const session of sessions) {
    const group = groups.get(session.projectIndex) ?? [];
    group.push(session);
    groups.set(session.projectIndex, group);
  }
  const directoryCount = integer(config.workspaceDirectories ?? groups.size);
  assert(
    directoryCount >= groups.size && directoryCount <= sessions.length,
    'Workspace directory count must cover groups without exceeding sessions',
  );
  const allocations = [...groups.values()].map((items) => ({ items, count: 1 }));
  for (let assigned = groups.size; assigned < directoryCount; assigned++) {
    const group = allocations
      .filter((g) => g.count < g.items.length)
      .sort((a, b) => b.items.length / b.count - a.items.length / a.count)[0];
    group.count++;
  }
  let directoryOffset = 0;
  for (const group of allocations) {
    group.items.forEach((session, index) => {
      session.workspaceIndex = directoryOffset + (index % group.count);
    });
    directoryOffset += group.count;
  }
  const stateOrder = shuffle([...sessions]);
  stateOrder.slice(totalSessions - archived).forEach((s) => {
    s.archived = true;
  });
  const active = stateOrder.filter((s) => !s.archived);
  active.slice(0, pinned).forEach((s) => {
    s.pinned = true;
  });
  // Keep one runnable root per project to ensure child associations are local.
  const rootsByProject = new Map();
  for (const s of sessions) {
    if (s.turns.some((t) => t.tools.length) && !rootsByProject.has(s.projectIndex))
      rootsByProject.set(s.projectIndex, s);
  }
  const candidates = shuffle(
    sessions.filter(
      (s) => rootsByProject.get(s.projectIndex)?.id !== s.id && rootsByProject.has(s.projectIndex),
    ),
  );
  assert(candidates.length >= childCount, 'Insufficient parent sessions with a tool boundary');
  for (const s of candidates.slice(0, childCount))
    s.parentId = rootsByProject.get(s.projectIndex).id;
  // A selected root with actual history is deterministic and newer than all others.
  const selected = sessions.find((s) => !s.archived && !s.parentId && s.turns.length);
  assert(selected, 'Scenario requires one active root with history');
  selected.ageMinutes = -1;
  const summary = {
    sessions: totalSessions,
    archived,
    active: totalSessions - archived,
    childSessions: childCount,
    pinned,
    projects: config.projectSessionCounts.length,
    workspaceDirectories: directoryCount,
    unassigned: sessions.filter((s) => s.projectIndex === null).length,
    turns: turnProfiles.length,
    tools: tools.length,
    userMessages: offsets.user,
    assistantMessages: offsets.assistant,
    reasoningMessages: offsets.reasoning,
    payloadBytes: Object.fromEntries(
      Object.entries(byteLists).map(([key, items]) => [key, items.reduce((a, b) => a + b, 0)]),
    ),
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ seed: config.seed, sessions }))
    .digest('hex');
  return {
    schemaVersion: 1,
    kind: 'synthetic-maka-workload',
    seed: config.seed,
    fingerprint,
    selectedSessionId: selected.id,
    summary,
    sessions,
  };
}

function integer(n) {
  assert(Number.isSafeInteger(n) && n >= 0, `Expected nonnegative integer: ${n}`);
  return n;
}
function expandCounts(entries, countKey, valueKey, numeric = true) {
  return entries.flatMap((entry) =>
    Array(integer(entry[countKey])).fill(numeric ? integer(entry[valueKey]) : entry[valueKey]),
  );
}
function seededRandom(seed) {
  assert(Number.isSafeInteger(seed), 'seed must be an integer');
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
