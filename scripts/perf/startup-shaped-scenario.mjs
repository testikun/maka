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

const categories = ['command', 'read', 'search', 'edit', 'mcp', 'delegate', 'image', 'web'];
const formats = ['text', 'code', 'json', 'diff', 'terminal', 'search', 'markdown', 'image'];
const toolSubtypes = [
  'default',
  'write',
  'edit',
  'read',
  'list',
  'search',
  'command',
  'spawn',
  'wait',
  'image',
  'web',
];
const noteSubtypes = ['compaction', 'agent-activity', 'sleep', 'orphan-output'];
const roles = ['user-root', 'spawned-child'];
const hintKeys = [
  'codeBlocks',
  'paragraphs',
  'headings',
  'listItems',
  'tableRows',
  'imageAttachments',
];
const idPattern = /^synthetic-session-\d{4,8}$/;
const count = (n, label) => {
  assert(Number.isSafeInteger(n) && n >= 0, `Invalid ${label}`);
  return n;
};
const bytes = (n) => {
  count(n, 'byte size');
  assert(n <= 16 * 1024 * 1024, 'Single fixture field exceeds 16 MiB');
  return n;
};
const enumValue = (n, allowed, label) => {
  assert(allowed.includes(n), `Invalid ${label}`);
  return n;
};

function imageShape(image) {
  return {
    mimeType: enumValue(
      image.mimeType,
      ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      'image MIME',
    ),
    encodedMimeType: enumValue(
      image.encodedMimeType,
      ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      'encoded image MIME',
    ),
    base64Chars: count(image.base64Chars, 'source base64 characters'),
    decodedBytes: count(image.decodedBytes, 'source decoded bytes'),
    ...(image.width !== undefined
      ? { width: count(image.width, 'image width'), height: count(image.height, 'image height') }
      : {}),
  };
}

function mcpShape(item) {
  if (!item.mcp) return {};
  assert.equal(item.category, 'mcp');
  const m = item.mcp;
  const result = {
    contentOrder: m.contentOrder.map((kind) =>
      enumValue(kind, ['text', 'image'], 'MCP content type'),
    ),
    textPartBytes: m.textPartBytes.map(bytes),
    structuredJsonBytes: bytes(m.structuredJsonBytes),
    images: m.images.map(imageShape),
    excludedMetaJsonBytes: count(m.excludedMetaJsonBytes, 'excluded private metadata bytes'),
    sourceResultJsonBytes: count(m.sourceResultJsonBytes, 'source result JSON bytes'),
  };
  assert.equal(
    result.contentOrder.filter((kind) => kind === 'text').length,
    result.textPartBytes.length,
  );
  assert.equal(result.contentOrder.filter((kind) => kind === 'image').length, result.images.length);
  assert.equal(
    result.textPartBytes.reduce((a, b) => a + b, 0) + result.structuredJsonBytes,
    item.outputBytes,
    'MCP text and structured output must be counted separately from images and metadata',
  );
  return { mcp: result };
}

function imageResultShape(item) {
  if (!item.imageResult) return {};
  assert.equal(item.category, 'image');
  assert.equal(item.outputBytes, 0);
  return {
    imageResult: {
      images: item.imageResult.images.map(imageShape),
      sourceResultBytes: count(
        item.imageResult.sourceResultBytes,
        'source encoded image result bytes',
      ),
    },
  };
}

// Strict structural whitelist: arbitrary text/path/title/ID fields from any
// observer are never copied into the independent generated scenario.
export function buildShapeScenario(config) {
  assert.equal(config.schemaVersion, 2);
  assert(Number.isSafeInteger(config.seed));
  assert(Array.isArray(config.sessions) && config.sessions.length > 0);
  const sessions = config.sessions.map((s, index) => {
    assert(idPattern.test(s.id), 'Only new synthetic session identities are accepted');
    assert(s.parentId === null || idPattern.test(s.parentId), 'Invalid synthetic parent identity');
    for (const key of ['archived', 'pinned', 'isChildUnlinked'])
      assert.equal(typeof s[key], 'boolean', `Invalid ${key}`);
    assert(Number.isFinite(s.ageMinutes) && s.ageMinutes >= 0, 'Invalid relative age');
    const turns = s.turns.map((t) => ({
      status: enumValue(t.status, ['completed', 'failed', 'aborted'], 'settled status'),
      sourceStatus: enumValue(
        t.sourceStatus,
        ['completed', 'failed', 'interrupted', 'inProgress', 'other'],
        'observed status',
      ),
      items: t.items.map((item) => {
        const kind = enumValue(
          item.kind,
          ['user', 'assistant', 'reasoning', 'tool', 'note'],
          'item kind',
        );
        if (kind === 'tool') {
          assert.equal(typeof item.isError, 'boolean');
          return {
            kind,
            category: enumValue(item.category, categories, 'tool category'),
            argumentBytes: bytes(item.argumentBytes),
            outputBytes: bytes(item.outputBytes),
            isError: item.isError,
            ...mcpShape(item),
            ...imageResultShape(item),
            ...(item.formatHint
              ? { formatHint: enumValue(item.formatHint, formats, 'format hint') }
              : {}),
            ...(item.subtype
              ? { subtype: enumValue(item.subtype, toolSubtypes, 'tool subtype') }
              : {}),
            ...(item.childIds
              ? {
                  childIds: item.childIds.map((id) => {
                    assert(idPattern.test(id));
                    return id;
                  }),
                }
              : {}),
          };
        }
        const formatHints = Object.fromEntries(
          hintKeys
            .filter((key) => item.formatHints?.[key] !== undefined)
            .map((key) => [key, count(item.formatHints[key], key)]),
        );
        if (item.formatHints?.utf8CodepointCounts) {
          const counts = item.formatHints.utf8CodepointCounts;
          assert.equal(counts.length, 4);
          counts.forEach((value) => count(value, 'UTF-8 codepoint count'));
          assert.equal(
            counts.reduce((n, value, index) => n + value * (index + 1), 0),
            item.bytes,
          );
          formatHints.utf8CodepointCounts = [...counts];
        }
        return {
          kind,
          bytes: bytes(item.bytes),
          ...(kind === 'note'
            ? { subtype: enumValue(item.subtype, noteSubtypes, 'note subtype') }
            : {}),
          ...(Object.keys(formatHints).length ? { formatHints } : {}),
        };
      }),
    }));
    const result = {
      id: s.id,
      projectIndex: s.projectIndex === null ? null : count(s.projectIndex, 'project index'),
      workspaceIndex: count(s.workspaceIndex, 'workspace index'),
      sourceRole: enumValue(s.sourceRole, roles, 'source role'),
      archived: s.archived,
      pinned: s.pinned,
      parentId: s.parentId,
      isChildUnlinked: s.isChildUnlinked,
      recencyRank: count(s.recencyRank, 'recency rank'),
      ageMinutes: s.ageMinutes,
      turns,
      ...(s.parentTurnIndex !== undefined
        ? {
            parentTurnIndex: count(s.parentTurnIndex, 'parent turn'),
            parentItemIndex: count(s.parentItemIndex, 'parent item'),
          }
        : {}),
    };
    const stat = shapeStatistics(result);
    result.name = `${s.archived ? 'Archived ' : ''}${s.parentId ? 'Child ' : ''}Fixture ${s.id.slice(-4)} - ${turns.length} turns - ${stat.tools} tools`;
    return result;
  });
  const byId = new Map(sessions.map((s) => [s.id, s]));
  assert.equal(byId.size, sessions.length, 'Duplicate synthetic identity');
  for (const session of sessions) {
    if (session.parentId) {
      assert(byId.has(session.parentId), 'Parent is not included');
      const visited = new Set([session.id]);
      let current = session;
      while (current.parentId) {
        assert(!visited.has(current.parentId), 'Cyclic parent relation');
        visited.add(current.parentId);
        current = byId.get(current.parentId);
        assert(current);
      }
    }
    assert(
      !session.isChildUnlinked,
      'Unlinked child requires an explicit supported materialization policy',
    );
    if (session.parentTurnIndex !== undefined) {
      const item = byId.get(session.parentId)?.turns[session.parentTurnIndex]?.items[
        session.parentItemIndex
      ];
      assert(
        item?.kind === 'tool' && item.childIds?.includes(session.id),
        'Unproven source spawn index',
      );
    }
  }
  const stats = sessions.map(shapeStatistics);
  const summary = {
    sessions: sessions.length,
    archived: sessions.filter((s) => s.archived).length,
    active: sessions.filter((s) => !s.archived).length,
    childSessions: sessions.filter((s) => s.parentId).length,
    pinned: sessions.filter((s) => s.pinned).length,
    projects: new Set(sessions.map((s) => s.projectIndex).filter((v) => v !== null)).size,
    workspaceDirectories: new Set(sessions.map((s) => s.workspaceIndex)).size,
    unassigned: sessions.filter((s) => s.projectIndex === null).length,
    turns: stats.reduce((n, s) => n + s.turns, 0),
    items: stats.reduce((n, s) => n + s.items, 0),
    tools: stats.reduce((n, s) => n + s.tools, 0),
    toolErrors: stats.reduce((n, s) => n + s.toolErrors, 0),
    userMessages: stats.reduce((n, s) => n + s.user, 0),
    assistantMessages: stats.reduce((n, s) => n + s.assistant, 0),
    reasoningMessages: stats.reduce((n, s) => n + s.reasoning, 0),
    notes: stats.reduce((n, s) => n + s.note, 0),
    imageAttachments: stats.reduce((n, s) => n + s.imageAttachments, 0),
    generatedImages: stats.reduce((n, s) => n + s.generatedImages, 0),
    generatedImageBytes: stats.reduce((n, s) => n + s.generatedImageBytes, 0),
    mcp: Object.fromEntries(
      [
        'calls',
        'images',
        'decodedImageBytes',
        'sourceBase64Chars',
        'textBytes',
        'structuredJsonBytes',
        'excludedMetaJsonBytes',
        'sourceResultJsonBytes',
      ].map((key) => [key, stats.reduce((n, s) => n + s.mcp[key], 0)]),
    ),
    payloadBytes: Object.fromEntries(
      ['user', 'assistant', 'reasoning', 'note', 'toolArguments', 'toolOutputs'].map((k) => [
        k,
        stats.reduce((n, s) => n + s.bytes[k], 0),
      ]),
    ),
  };
  const candidates = stats.filter((s) => !s.isChild);
  const max = (rows, key) =>
    [...rows].sort((a, b) => b[key] - a[key] || a.id.localeCompare(b.id))[0];
  const showcases = {
    'longest-active-root': max(
      candidates.filter((s) => !s.archived),
      'payloadBytes',
    ),
    'dense-active-root': max(
      candidates.filter((s) => !s.archived),
      'tools',
    ),
    'most-turns-root': max(
      candidates.filter((s) => !s.archived),
      'turns',
    ),
    'longest-archived-root': max(
      candidates.filter((s) => s.archived),
      'payloadBytes',
    ),
    'most-tools-root': max(candidates, 'tools'),
    'image-heavy-active-root': max(
      candidates.filter((s) => !s.archived),
      'totalImages',
    ),
    'source-largest-active-root': max(
      candidates.filter((s) => !s.archived),
      'sourcePayloadBytes',
    ),
  };
  for (const [key, value] of Object.entries(showcases)) if (!value) delete showcases[key];
  assert(showcases['longest-active-root'], 'No active root with history');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ seed: config.seed, sessions }))
    .digest('hex');
  return {
    schemaVersion: 2,
    kind: 'synthetic-maka-workload-shaped',
    seed: config.seed,
    fingerprint,
    selectedSessionId: showcases['longest-active-root'].id,
    summary,
    showcases,
    sessionStatistics: stats,
    sessions,
  };
}

export function shapeStatistics(session) {
  const result = {
    id: session.id,
    archived: session.archived,
    isChild: Boolean(session.parentId),
    turns: session.turns.length,
    items: 0,
    tools: 0,
    toolErrors: 0,
    user: 0,
    assistant: 0,
    reasoning: 0,
    note: 0,
    imageAttachments: 0,
    generatedImages: 0,
    generatedImageBytes: 0,
    sourceImageResultBytes: 0,
    mcp: {
      calls: 0,
      images: 0,
      decodedImageBytes: 0,
      sourceBase64Chars: 0,
      textBytes: 0,
      structuredJsonBytes: 0,
      excludedMetaJsonBytes: 0,
      sourceResultJsonBytes: 0,
    },
    maxTurnTools: 0,
    maxTurnItems: 0,
    bytes: { user: 0, assistant: 0, reasoning: 0, note: 0, toolArguments: 0, toolOutputs: 0 },
  };
  for (const turn of session.turns) {
    result.maxTurnItems = Math.max(result.maxTurnItems, turn.items.length);
    let tools = 0;
    for (const item of turn.items) {
      result.items++;
      if (item.kind === 'tool') {
        result.tools++;
        tools++;
        result.toolErrors += Number(item.isError);
        result.bytes.toolArguments += item.argumentBytes;
        result.bytes.toolOutputs += item.outputBytes;
        if (item.imageResult) {
          result.generatedImages += item.imageResult.images.length;
          result.generatedImageBytes += item.imageResult.images.reduce(
            (n, image) => n + image.decodedBytes,
            0,
          );
          result.sourceImageResultBytes += item.imageResult.sourceResultBytes;
        }
        if (item.mcp) {
          result.mcp.calls++;
          result.mcp.images += item.mcp.images.length;
          result.mcp.decodedImageBytes += item.mcp.images.reduce(
            (n, image) => n + image.decodedBytes,
            0,
          );
          result.mcp.sourceBase64Chars += item.mcp.images.reduce(
            (n, image) => n + image.base64Chars,
            0,
          );
          result.mcp.textBytes += item.mcp.textPartBytes.reduce((n, value) => n + value, 0);
          for (const key of [
            'structuredJsonBytes',
            'excludedMetaJsonBytes',
            'sourceResultJsonBytes',
          ])
            result.mcp[key] += item.mcp[key];
        }
      } else {
        result[item.kind]++;
        result.bytes[item.kind] += item.bytes;
        result.imageAttachments += item.formatHints?.imageAttachments ?? 0;
      }
    }
    result.maxTurnTools = Math.max(result.maxTurnTools, tools);
  }
  result.payloadBytes = Object.values(result.bytes).reduce((a, b) => a + b, 0);
  result.totalImages = result.imageAttachments + result.mcp.images + result.generatedImages;
  result.sourcePayloadBytes =
    result.payloadBytes +
    result.mcp.sourceResultJsonBytes -
    result.mcp.textBytes -
    result.mcp.structuredJsonBytes +
    result.sourceImageResultBytes;
  return result;
}

// Thinking belongs to an assistant message in Maka. Only attach a segment to
// the immediately following answer; crossing a tool would reorder the UI.
export function planReasoningAnchors(items, prefix) {
  const anchors = new Map();
  for (let start = 0; start < items.length; start++) {
    if (items[start].kind !== 'reasoning') continue;
    let end = start + 1;
    while (items[end]?.kind === 'reasoning') end++;
    const hasAnswer = items[end]?.kind === 'assistant';
    const providerEventId = hasAnswer
      ? prefix + '_item' + end
      : prefix + '_reasoning_carrier_' + start;
    for (let i = start; i < end; i++)
      anchors.set(i, { providerEventId, carrierAfter: !hasAnswer && i === end - 1 });
    start = end - 1;
  }
  return anchors;
}

// Pure synthetic prose, code fences, lists and tables. Exact UTF-8 byte length;
// no input text is accepted. Hints are layout targets, not promises that an
// arbitrarily short message can accommodate a complete Markdown construct.
export function fakeMessageText(size, { kind = 'assistant', ordinal = 0, formatHints = {} } = {}) {
  bytes(size);
  if (!size) return '';
  if (formatHints.utf8CodepointCounts) {
    const counts = formatHints.utf8CodepointCounts;
    assert.equal(
      counts.reduce((n, value, index) => n + value * (index + 1), 0),
      size,
    );
    const { utf8CodepointCounts: _counts, ...layout } = formatHints;
    const chars = [
      ...fakeMessageText(
        counts.reduce((a, b) => a + b, 0),
        { kind, ordinal, formatHints: layout },
      ),
    ];
    const needed = counts.slice(1).reduce((a, b) => a + b, 0);
    // Prefer replacing letters so code fences, headings and line breaks survive.
    const letters = [],
      other = [];
    chars.forEach((char, index) => (/\w/.test(char) ? letters : other).push(index));
    const positions = needed <= letters.length ? letters : [...letters, ...other];
    let replaced = 0;
    for (let width = 2; width <= 4; width++) {
      for (let index = 0; index < counts[width - 1]; index++) {
        const position = positions[Math.floor((replaced++ * positions.length) / needed)];
        chars[position] = width === 2 ? 'é' : width === 3 ? '合成示例文本'[index % 6] : '🧪';
      }
    }
    const result = chars.join('');
    assert.equal(Buffer.byteLength(result), size);
    return result;
  }
  const parts = [];
  let used = 0;
  const add = (text) => {
    if (used + text.length > size) return false;
    parts.push(text);
    used += text.length;
    return true;
  };
  if (formatHints.headings) add(`## Synthetic ${kind} step ${ordinal}\n\n`);
  for (let i = 0; i < (formatHints.codeBlocks ?? 0); i++)
    if (
      !add(
        `\n\n\x60\x60\x60javascript\n// Generated fixture ${ordinal}, example ${i}\nexport const sample${i} = { ready: true, index: ${i} };\n\x60\x60\x60\n\n`,
      )
    )
      break;
  if (formatHints.tableRows)
    add(
      '\n| Generated check | Result |\n|---|---|\n| Isolated input | ready |\n| Synthetic output | accepted |\n\n',
    );
  if (formatHints.listItems)
    add(
      '- Inspect a generated sample module.\n- Compare the synthetic result.\n- Record the fixture outcome.\n\n',
    );
  const paragraphs = Math.max(1, Math.min(formatHints.paragraphs ?? 1, Math.ceil(size / 24)));
  const paragraphSize = Math.max(24, Math.floor((size - used) / paragraphs));
  for (let block = 0; used < size; block++) {
    const line = `Synthetic ${kind} ${ordinal}, section ${block}. This generated discussion follows a sample investigation, records the observations, and explains the next validation step. `;
    let text =
      line.repeat(Math.ceil(paragraphSize / line.length)).slice(0, Math.max(1, paragraphSize - 2)) +
      '\n\n';
    text = text.slice(0, size - used);
    parts.push(text);
    used += text.length;
  }
  return parts.join('');
}
