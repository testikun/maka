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

/**
 * Adapters from numeric/enum workload shapes to synthetic Maka results.
 * buildFakeTool is pure. The async media builders publish only generated image
 * bytes through the supplied fixture artifact writer. No command/tool/provider
 * is executed. `cwd`/`fixtureId` must be newly generated fixture identities.
 *
 * Contract: outputBytes measures the UTF-8 bytes in the primary result fields,
 * not JSON envelopes, metadata or repeated provider-visible projections. Those
 * costs are returned separately in byteAccounting. Arguments use valid Maka
 * input shapes; bounded Read/Grep arguments cannot reproduce arbitrarily long
 * provider argument JSON, and the difference is explicit rather than hidden in
 * a made-up field on a built-in tool.
 */
import { decodeCanonicalToolResultContent } from '@maka/core/tool-result-record-schema';
import { decodeDurableToolResultProjection } from '@maka/core/durable-tool-result-projection';
import { shapeTerminalResult } from '@maka/runtime/shell-tools';
import { buildMcpTools } from '@maka/runtime/mcp-tools';
import {
  encodeDurableToolResultOutput,
  encodeDurableToolResultOutputWithArtifacts,
  encodeDefaultDurableToolResultOutput,
} from '@maka/runtime/durable-tool-result-projection';
import { normalizeWebSearchQuery, WEB_SEARCH_QUERY_MAX_CHARS } from '@maka/core/web-search';
import { bashToolResultToModelOutput } from '../../packages/runtime/dist/bash-model-output.js';
import { BASH_MAX_RETAINED_CHARS } from '../../packages/runtime/dist/shell-exec.js';
import { createSyntheticToolImage } from './startup-fixture-media.mjs';
import { readPage, READ_PAGE_MAX_CHARS } from '../../packages/runtime/dist/read-page.js';
import {
  GREP_MAX_LINES,
  GREP_MAX_LINES_PER_FILE,
  GREP_MAX_MATCH_BYTES,
} from '../../packages/runtime/dist/grep-search.js';

export const MAX_FAKE_TOOL_TEXT_BYTES = 16 * 1024 * 1024;
export const FAKE_TOOL_CATEGORIES = Object.freeze([
  'command',
  'read',
  'search',
  'edit',
  'mcp',
  'delegate',
  'image',
  'web',
]);
export const FAKE_TOOL_FORMAT_HINTS = Object.freeze([
  'plain',
  'text',
  'code',
  'json',
  'diff',
  'terminal',
  'search',
  'markdown',
  'image',
]);
export const FAKE_TOOL_SUBTYPES = Object.freeze([
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
]);

const bytes = (text) => Buffer.byteLength(text, 'utf8');
const jsonBytes = (value) => bytes(JSON.stringify(value));
// Reuse the production MCP model adapter without running its impl/provider.
const [mcpModelAdapter] = buildMcpTools({
  toolSnapshot: () => ({
    revision: 1,
    tools: [
      {
        binding: 'synthetic-binding',
        descriptor: {
          serverId: 'fixture',
          name: 'inspect_records',
          description: 'Synthetic fixture adapter',
          inputSchema: { type: 'object' },
        },
      },
    ],
  }),
  callTool: () => {
    throw new Error('Fixture tools must never execute');
  },
});
const mcpModelOutput = (raw) =>
  mcpModelAdapter.toModelOutput({ toolCallId: 'synthetic-call', input: {}, output: raw });

function count(value, name, maximum = MAX_FAKE_TOOL_TEXT_BYTES) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new RangeError(`${name} must be an integer between 0 and ${maximum}`);
  return value;
}

function enumeration(value, allowed, name) {
  if (!allowed.includes(value)) throw new TypeError(`Unsupported ${name}`);
  return value;
}

/** ASCII templates make byte slicing exact, including targets of 0 or 1 byte. */
function fakeText(size, style, ordinal) {
  const chunks = [];
  let remaining = size;
  for (let block = 0; remaining > 0; block++) {
    const label = `fixture ${ordinal}, block ${block}`;
    let text;
    switch (style) {
      case 'code':
        text = `// Synthetic ${label}\nexport function fixtureStep${block}(value) {\n  const next = value + ${block % 17};\n  return { state: 'ready', value: next };\n}\n\n`;
        break;
      case 'json':
        text = `{"fixture":${ordinal},"block":${block},"state":"ready","records":[{"index":0,"label":"synthetic first"},{"index":1,"label":"synthetic next"}]}\n`;
        break;
      case 'terminal':
        text = `> synthetic check group ${block}\nPASS fixtures/check-${block}.test.mjs\n  [ok] ${label}: reads isolated input\n  [ok] deterministic result accepted\n\n`;
        break;
      case 'search':
        text = `src/fixture-${block % 11}.ts:${block + 1}: export const fixtureValue${block} = ${ordinal};\n`;
        break;
      case 'markdown':
        text = `### Synthetic step ${block}\n\nThe generated example checks fixture ${ordinal} using isolated sample input.\n\n- Read the sample module.\n- Compare its expected state.\n- Record the synthetic result.\n\n`;
        break;
      case 'diff':
        text = `-const previous${block} = 'synthetic-old';\n+const current${block} = 'synthetic-new';\n`;
        break;
      default:
        text = `Synthetic ${label}.\nThe sample result contains generated observations and no source conversation text.\nA second line records the deterministic outcome.\n\n`;
    }
    const part = text.slice(0, remaining);
    chunks.push(part);
    remaining -= part.length;
  }
  return chunks.join('');
}

function paddedArguments(base, field, size, style, ordinal, limit = MAX_FAKE_TOOL_TEXT_BYTES) {
  const emptyBytes = jsonBytes({ ...base, [field]: '' });
  // requestedArgumentBytes is a serialized source argument size. JSON escaping
  // contributes too; search the payload size rather than adding the whole size.
  let low = 0;
  let high = Math.min(size, limit);
  const sample = fakeText(high, style, ordinal);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (emptyBytes + jsonBytes(sample.slice(0, middle)) - 2 <= size) low = middle;
    else high = middle - 1;
  }
  const value = sample.slice(0, low);
  const args = { ...base, [field]: value };
  // Fill the possible single-byte remainder with harmless ASCII whitespace.
  const remainder = size - jsonBytes(args);
  if (remainder > 0 && value.length + remainder <= limit) args[field] += ' '.repeat(remainder);
  return args;
}

function commandArguments(size, ordinal) {
  // Every line is either a shell no-op or a comment. These are display strings,
  // never sent to a process; even accidental copying cannot mutate files.
  const prefix = ': # synthetic fixture command; never executed\n';
  const lines = fakeText(Math.max(size, prefix.length), 'terminal', ordinal)
    .split('\n')
    .map((line) => `# ${line}`)
    .join('\n');
  const command = prefix + lines;
  const baseBytes = jsonBytes({ command: '' });
  const target = Math.max(size, baseBytes + jsonBytes(prefix) - 2);
  let low = prefix.length;
  let high = command.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes({ command: command.slice(0, middle) }) <= target) low = middle;
    else high = middle - 1;
  }
  const value = command.slice(0, low);
  return { command: value + ' '.repeat(Math.max(0, target - jsonBytes({ command: value }))) };
}

function syntheticDiff(size, path, ordinal) {
  const prefix = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  const removed = '-export const fixtureEnabled = false;\n';
  // A complete hunk needs a header, removed line and at least one added line.
  // Tiny source responses cannot carry a valid diff; the caller returns text.
  let lines = Math.max(1, Math.floor((size - prefix.length - removed.length - 32) / 100));
  let header;
  let remaining;
  do {
    header = `${prefix}@@ -1,1 +1,${lines} @@\n${removed}`;
    remaining = size - header.length - lines * 2; // '+' and '\n' on every line
    if (remaining >= 0) break;
    lines--;
  } while (lines > 0);
  if (lines < 1) return undefined;
  const additions = [];
  for (let index = 0; index < lines; index++) {
    const allocation = Math.floor(remaining / (lines - index));
    const line = `// synthetic fixture ${ordinal}, changed line ${index}; sample value ${index % 17} `;
    const text = line.repeat(Math.ceil(allocation / line.length)).slice(0, allocation);
    additions.push(`+${text}\n`);
    remaining -= allocation;
  }
  return header + additions.join('');
}

function nativeSearchMatches(size, ordinal) {
  if (size === 0) return [];
  if (size > GREP_MAX_MATCH_BYTES) return undefined;
  // Roughly 96 chars per synthetic match keeps normal code lines readable.
  // This is a visual synthesis choice, not a claimed source line distribution.
  const lineCount = Math.min(GREP_MAX_LINES, Math.max(1, Math.floor(size / 96)));
  const matches = [];
  let remaining = size;
  for (let index = 0; index < lineCount; index++) {
    const allocation = Math.floor(remaining / (lineCount - index));
    // A different file for each 50-line group follows the native per-file cap.
    const pathIndex = Math.floor(index / GREP_MAX_LINES_PER_FILE);
    const line = (index % GREP_MAX_LINES_PER_FILE) + 1;
    const prefix = `src/fixture-${pathIndex}.ts:${line}: export const fixtureValue${index} = ${ordinal % 97};`;
    if (allocation < prefix.length) return undefined;
    const padding = ` /* synthetic sample ${index} */`;
    matches.push(
      prefix +
        padding
          .repeat(Math.ceil((allocation - prefix.length) / padding.length))
          .slice(0, allocation - prefix.length),
    );
    remaining -= allocation;
  }
  return jsonBytes(matches) <= GREP_MAX_MATCH_BYTES ? matches : undefined;
}

function durableProjection(result) {
  const projection =
    result.kind === 'terminal'
      ? encodeDurableToolResultOutput(bashToolResultToModelOutput(result), 'fixture')
      : encodeDefaultDurableToolResultOutput(
          result.kind === 'json' ? result.value : result,
          'fixture',
        );
  return { projection, truncated: projection.kind === 'failure' };
}

export function buildFakeTool({
  category,
  argumentBytes,
  outputBytes,
  isError = false,
  formatHint = 'text',
  subtype = 'default',
  ordinal = 0,
  cwd = '/synthetic-fixture/project',
  fixtureId = 'fixture',
}) {
  enumeration(category, FAKE_TOOL_CATEGORIES, 'category');
  enumeration(formatHint, FAKE_TOOL_FORMAT_HINTS, 'formatHint');
  enumeration(subtype, FAKE_TOOL_SUBTYPES, 'subtype');
  count(argumentBytes, 'argumentBytes');
  count(outputBytes, 'outputBytes');
  count(ordinal, 'ordinal', Number.MAX_SAFE_INTEGER);
  if (typeof isError !== 'boolean') throw new TypeError('isError must be boolean');
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.length > 4096 || /[\r\n\0]/.test(cwd))
    throw new TypeError('cwd must be a bounded absolute synthetic path');
  if (typeof fixtureId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(fixtureId))
    throw new TypeError('fixtureId must be a generated fixture identifier');

  const path = `src/fixture-${ordinal % 97}.ts`;
  const style =
    formatHint === 'text' || formatHint === 'plain'
      ? {
          command: 'terminal',
          read: 'code',
          search: 'search',
          edit: 'diff',
          mcp: 'json',
          delegate: 'markdown',
          image: 'plain',
          web: 'markdown',
        }[category]
      : formatHint;
  let body = fakeText(outputBytes, style, ordinal);
  let toolName;
  let args;
  let result;
  const activityKind =
    { command: 'command', read: 'read', search: 'search', edit: 'edit' }[category] ?? 'tool';
  const limitations = [];
  let outputTextFields;
  let wrapperMapping;

  switch (category) {
    case 'command':
      toolName =
        body.length <= BASH_MAX_RETAINED_CHARS ? 'Bash' : 'mcp__fixture__terminal_snapshot';
      args = commandArguments(argumentBytes, ordinal);
      result = shapeTerminalResult({
        cwd,
        command: args.command,
        result: {
          stdout: isError ? '' : body,
          stderr: isError ? body : '',
          exitCode: isError ? 1 : 0,
        },
      });
      outputTextFields = [isError ? 'output.stderr' : 'output.stdout'];
      if (toolName !== 'Bash') {
        wrapperMapping = {
          sourceCategory: 'command',
          nativeEquivalent: 'Bash',
          materializedToolName: toolName,
          mode: 'synthetic-snapshot',
          reason: 'bash-stream-retention-cap',
          limits: { retainedUtf16CharsPerStream: BASH_MAX_RETAINED_CHARS },
        };
        limitations.push(
          'The source-sized terminal body exceeds native Bash per-stream retention. An explicit synthetic snapshot preserves its full bytes and terminal preview.',
        );
      }
      break;
    case 'read': {
      const lineCount = body.split('\n').length;
      args = { path, offset: 0, limit: Math.max(1, lineCount) };
      // Use the real page shaper, including its JSON escaping and continuation
      // overhead. Large source reads are snapshots, not impossible native pages.
      const page =
        !isError && body.length <= READ_PAGE_MAX_CHARS ? readPage(body, args) : undefined;
      const native = page?.content === body && page.next === null;
      toolName = native ? 'Read' : 'mcp__fixture__read_snapshot';
      result = {
        kind: 'json',
        value: native
          ? page
          : {
              synthetic: true,
              sourceCategory: 'read',
              ok: !isError,
              content: body,
            },
      };
      outputTextFields = ['value.content'];
      wrapperMapping = {
        sourceCategory: category,
        nativeEquivalent: 'Read',
        materializedToolName: toolName,
        mode: native ? 'native-shaped' : 'synthetic-snapshot',
        reason: native
          ? 'within-native-limits'
          : isError
            ? 'native-error-details-not-modeled'
            : 'read-page-cap',
        limits: { pageJsonUtf16Chars: READ_PAGE_MAX_CHARS },
      };
      limitations.push(
        'Read arguments follow the native path/offset/limit schema; source argument byte size is recorded, not padded into an invalid extra field.',
      );
      if (!native)
        limitations.push(
          'The full read/error body is an explicit synthetic MCP snapshot. It does not claim to be a native bounded Read page or a real filesystem error.',
        );
      break;
    }
    case 'search': {
      args = { pattern: 'fixture(Value|Enabled)', path: 'src', glob: '**/*.ts' };
      const matches = isError ? undefined : nativeSearchMatches(outputBytes, ordinal);
      const native = matches !== undefined;
      toolName = native ? 'Grep' : 'mcp__fixture__search_snapshot';
      if (native) body = matches.join('');
      result = {
        kind: 'json',
        value: native
          ? {
              matches,
              matchedLines: matches.length,
              returnedLines: matches.length,
              omittedLines: 0,
              truncated: false,
            }
          : { synthetic: true, sourceCategory: 'search', ok: !isError, content: body },
      };
      outputTextFields = [native ? 'value.matches[*]' : 'value.content'];
      wrapperMapping = {
        sourceCategory: category,
        nativeEquivalent: 'Grep',
        materializedToolName: toolName,
        mode: native ? 'native-shaped' : 'synthetic-snapshot',
        reason: native
          ? 'within-native-limits'
          : isError
            ? 'native-error-details-not-modeled'
            : outputBytes < 96
              ? 'search-shape-too-short'
              : 'search-result-cap',
        limits: {
          rows: GREP_MAX_LINES,
          rowsPerFile: GREP_MAX_LINES_PER_FILE,
          matchesJsonBytes: GREP_MAX_MATCH_BYTES,
        },
      };
      limitations.push(
        'Native Grep uses generated single-line path:line:content matches. The sum of match string bytes equals the requested body size; JSON envelope cost is recorded separately.',
      );
      if (!native)
        limitations.push(
          'The complete search/error body is an explicit synthetic MCP snapshot. It is not labeled as an oversized native Grep response; no body is discarded.',
        );
      break;
    }
    case 'edit': {
      // Deliberately NOT the built-in Edit/Write/apply_patch: those names carry
      // workspace authority and managed mutation evidence beyond UI events.
      toolName = subtype === 'write' ? 'mcp__fixture__preview_write' : 'mcp__fixture__preview_edit';
      args = paddedArguments(
        { path, operation: subtype === 'write' ? 'write-preview' : 'edit-preview' },
        'patch',
        argumentBytes,
        'diff',
        ordinal,
      );
      const diff = isError ? undefined : syntheticDiff(outputBytes, path, ordinal);
      if (diff !== undefined) {
        body = diff;
        result = { kind: 'file_diff', paths: [path], diff };
        outputTextFields = ['diff'];
      } else {
        result = { kind: 'text', text: body };
        outputTextFields = ['text'];
        if (!isError)
          limitations.push(
            'Requested output is smaller than one complete unified diff; shown as text.',
          );
      }
      limitations.push(
        'This is a synthetic diff preview, without filesystem mutation, managedMutation authority, undo data or mutation recovery coverage.',
      );
      break;
    }
    case 'delegate':
      toolName =
        subtype === 'spawn'
          ? 'agent_spawn'
          : subtype === 'wait'
            ? 'mcp__fixture__agent_wait_snapshot'
            : 'mcp__fixture__agent_activity_snapshot';
      args = paddedArguments(
        { profile: 'local_read', task: '' },
        'task',
        argumentBytes,
        'markdown',
        ordinal,
        60_000,
      );
      if (args.task.length === 0) args.task = 'Review this synthetic fixture.';
      result = {
        kind: 'subagent',
        agentName: `Synthetic reader ${(ordinal % 7) + 1}`,
        turnId: `${fixtureId}_delegate_${ordinal}`,
        status: isError ? 'failed' : 'completed',
        permissionMode: 'explore',
        summary: body,
        artifactIds: [],
        ...(isError ? { failureClass: 'synthetic_failure' } : {}),
      };
      outputTextFields = ['summary'];
      wrapperMapping = {
        sourceCategory: category,
        materializedToolName: toolName,
        mode: subtype === 'spawn' ? 'native-shaped' : 'synthetic-snapshot',
        reason:
          subtype === 'spawn'
            ? 'native-legacy-profile-selector'
            : 'delegate-observation-is-not-spawn',
      };
      limitations.push(
        'Subagent result renders the native agent row. No childSessionId is invented; linking real synthetic child sessions is the materializer responsibility.',
      );
      break;
    case 'web':
      // TAVILY_RESULT_SNIPPET_MAX_CHARS in runtime/tavily-search.ts. A single
      // native row cannot contain the entire body of a larger source response.
      toolName = !isError && body.length <= 400 ? 'WebSearch' : 'mcp__fixture__web_search_snapshot';
      args = paddedArguments(
        {},
        'query',
        argumentBytes,
        'plain',
        ordinal,
        WEB_SEARCH_QUERY_MAX_CHARS,
      );
      if (!args.query) args.query = 'synthetic fixture guide';
      limitations.push(
        'WebSearch query follows the native 200-character maximum; any source argument-size difference is recorded.',
      );
      result = isError
        ? {
            kind: 'web_search_error',
            ok: false,
            provider: 'synthetic',
            query: normalizeWebSearchQuery(args.query),
            reason: 'synthetic_failure',
            message: body,
          }
        : {
            kind: 'web_search',
            provider: toolName === 'WebSearch' ? 'tavily' : 'synthetic',
            query: normalizeWebSearchQuery(args.query),
            rows: [
              {
                title: `Synthetic guide ${ordinal}`,
                url: `https://example.invalid/fixture/${ordinal}`,
                source: 'example.invalid',
                snippet: body,
              },
            ],
          };
      outputTextFields = [isError ? 'message' : 'rows[0].snippet'];
      wrapperMapping = {
        sourceCategory: category,
        nativeEquivalent: 'WebSearch',
        materializedToolName: toolName,
        mode: toolName === 'WebSearch' ? 'native-shaped' : 'synthetic-snapshot',
        reason:
          toolName === 'WebSearch'
            ? 'within-native-limits'
            : isError
              ? 'native-error-details-not-modeled'
              : 'web-snippet-cap',
        limits: { queryChars: WEB_SEARCH_QUERY_MAX_CHARS, snippetCharsPerRow: 400 },
      };
      if (toolName !== 'WebSearch')
        limitations.push(
          'Source-sized web output is an explicit snapshot, preserving the full body rather than claiming an oversized native provider row or an invented provider error.',
        );
      limitations.push(
        'Web rows are generated display data with reserved .invalid URLs; no provider or network operation occurred.',
      );
      break;
    case 'image':
      toolName = 'mcp__fixture__image_descriptor';
      args = paddedArguments(
        { path: `assets/fixture-${ordinal}.png` },
        'description',
        argumentBytes,
        'plain',
        ordinal,
      );
      result = {
        kind: 'json',
        value: {
          synthetic: true,
          mediaType: 'image/png',
          width: 1280,
          height: 800,
          body,
          rendering: 'descriptor-only; no stored image artifact',
        },
      };
      outputTextFields = ['value.body'];
      limitations.push(
        'Image calls retain textual result size only; this adapter cannot reproduce decoded image memory, attachment storage or image preview without materializer-owned fake media artifacts.',
      );
      break;
    case 'mcp':
      toolName = `mcp__fixture__${subtype === 'list' ? 'list_records' : 'inspect_records'}`;
      args = paddedArguments(
        { scope: `synthetic-${ordinal % 13}` },
        'query',
        argumentBytes,
        'json',
        ordinal,
      );
      result = {
        kind: 'json',
        value: {
          content: [{ type: 'text', text: body }],
        },
      };
      if (isError) {
        toolName = 'mcp__fixture__error_snapshot';
        wrapperMapping = {
          sourceCategory: 'mcp',
          materializedToolName: toolName,
          mode: 'synthetic-snapshot',
          reason: 'native-error-details-not-modeled',
        };
        limitations.push(
          'Error content is a synthetic snapshot; the real MCP manager throws and summarizes server errors before returning normalized content.',
        );
      }
      outputTextFields = ['value.content[0].text'];
      break;
  }

  decodeCanonicalToolResultContent(result);
  const mcpOutput = category === 'mcp' ? mcpModelOutput(result.value) : undefined;
  const projected = mcpOutput
    ? {
        projection: encodeDurableToolResultOutput(mcpOutput, 'fixture'),
        truncated: mcpOutput.value.some((part) => part.type === 'text' && part.text !== body),
      }
    : durableProjection(result);
  const { projection: modelProjection, truncated: projectionTruncated } = projected;
  if (projectionTruncated)
    limitations.push(
      'The full result remains intact; the separate model projection follows production clipping/size limits (including the failure sentinel when the production encoder rejects it).',
    );
  return {
    toolName,
    args,
    result,
    modelProjection,
    activityKind,
    isError,
    wrapperMapping: wrapperMapping ?? {
      sourceCategory: category,
      materializedToolName: toolName,
      mode: 'synthetic-adapter',
    },
    // Settled fixture records are never replayed. Avoid claiming arbitrary shell,
    // MCP, agent or previewed changes are safe to run automatically after a crash.
    recoveryMode: toolName === 'Read' || toolName === 'Grep' ? 'replay_safe' : 'never_auto_retry',
    byteAccounting: {
      requestedArgumentBytes: argumentBytes,
      actualArgumentsJsonBytes: jsonBytes(args),
      argumentJsonDeltaBytes: jsonBytes(args) - argumentBytes,
      requestedOutputBytes: outputBytes,
      actualEmbeddedOutputBytes: bytes(body),
      outputTextFields,
      outputJsonFields: [],
      resultJsonBytes: jsonBytes(result),
      resultEnvelopeAndEscapingBytes: jsonBytes(result) - bytes(body),
      modelProjectionJsonBytes: jsonBytes(modelProjection),
      projectionTruncated,
    },
    limitations,
  };
}

function syntheticJson(size, ordinal) {
  if (size === 0) return undefined;
  if (size === 1) return 0;
  const base = { synthetic: true, records: [{ index: ordinal, state: 'complete' }], content: '' };
  if (size < jsonBytes(base)) return 's'.repeat(size - 2);
  return paddedArguments(base, 'content', size, 'plain', ordinal);
}

/**
 * Materialize observed MCP modalities through Maka's actual provider adapter
 * and durable image projection path. Only lengths, dimensions and safe MIME
 * enums enter this function; private _meta is counted but never synthesized.
 */
export async function buildFakeMcpTool({ mcpShape, artifactStore, sessionId, turnId, ...input }) {
  if (input.category !== undefined && input.category !== 'mcp')
    throw new TypeError('Expected MCP category');
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId))
    throw new TypeError('Expected synthetic sessionId');
  if (typeof turnId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(turnId))
    throw new TypeError('Expected synthetic turnId');
  const shape = mcpShape ?? {
    textPartBytes: [input.outputBytes],
    structuredJsonBytes: 0,
    images: [],
    excludedMetaJsonBytes: 0,
    sourceResultJsonBytes: 0,
  };
  if (!Array.isArray(shape.textPartBytes) || !Array.isArray(shape.images))
    throw new TypeError('Invalid MCP modality shape');
  if (shape.textPartBytes.length + shape.images.length > 256)
    throw new RangeError('MCP content exceeds production 256-block budget');
  shape.textPartBytes.forEach((size) => count(size, 'MCP text bytes'));
  count(shape.structuredJsonBytes, 'MCP structured JSON bytes');
  count(shape.excludedMetaJsonBytes, 'MCP excluded metadata bytes', Number.MAX_SAFE_INTEGER);
  count(shape.sourceResultJsonBytes, 'MCP source JSON bytes', Number.MAX_SAFE_INTEGER);
  const requestedBytes =
    shape.textPartBytes.reduce((sum, size) => sum + size, 0) + shape.structuredJsonBytes;
  if (requestedBytes !== input.outputBytes)
    throw new Error(
      'MCP primary bytes must equal text parts plus structured JSON, excluding media and metadata',
    );
  count(requestedBytes, 'MCP primary bytes');
  const tool = buildFakeTool({ ...input, category: 'mcp', outputBytes: 0 });
  const ordinal = input.ordinal ?? 0;
  const textBlocks = shape.textPartBytes.map((size, index) => ({
    type: 'text',
    text: fakeText(size, 'markdown', ordinal + index),
  }));
  const structuredContent = syntheticJson(shape.structuredJsonBytes, ordinal);
  const images = [];
  // Sequential encoding bounds peak image memory and avoids 210 simultaneous
  // libvips jobs when one session contains many screenshots.
  for (let index = 0; index < shape.images.length; index++)
    images.push(
      await createSyntheticToolImage({
        shape: shape.images[index],
        ordinal: ordinal * 256 + index,
      }),
    );
  const contentOrder = shape.contentOrder ?? [
    ...textBlocks.map(() => 'text'),
    ...images.map(() => 'image'),
  ];
  if (
    !Array.isArray(contentOrder) ||
    contentOrder.some((kind) => kind !== 'text' && kind !== 'image') ||
    contentOrder.filter((kind) => kind === 'text').length !== textBlocks.length ||
    contentOrder.filter((kind) => kind === 'image').length !== images.length
  )
    throw new TypeError('MCP contentOrder must exactly describe its text and image blocks');
  let nextText = 0;
  let nextImage = 0;
  const content = contentOrder.map((kind) =>
    kind === 'text' ? textBlocks[nextText++] : images[nextImage++].block,
  );
  const raw = {
    content,
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
  tool.result = decodeCanonicalToolResultContent({ kind: 'json', value: raw });
  const output = mcpModelOutput(raw);
  let planner;
  if (images.length) {
    if (!artifactStore || typeof artifactStore.create !== 'function')
      throw new TypeError('MCP images require the fixture artifact writer');
    const { createReadImageSnapshotPlanner } = await import('@maka/storage/artifact-stores');
    planner = createReadImageSnapshotPlanner(artifactStore);
  }
  const artifactPlans = [];
  tool.modelProjection = await encodeDurableToolResultOutputWithArtifacts(
    output,
    sessionId,
    planner
      ? ({ bytes, mediaType }) => {
          // Same name/source/identity calculation as production composition.
          const plan = planner({
            sessionId,
            turnId,
            name: 'Tool Result image',
            bytes,
            mimeType: mediaType,
          });
          artifactPlans.push({ ref: plan.ref, bytes: bytes.length });
          return plan;
        }
      : undefined,
  );
  decodeDurableToolResultProjection(tool.modelProjection);
  const modelText = output.value.filter((part) => part.type === 'text');
  const modelImages = output.value.filter((part) => part.type === 'file');
  const projectionFailed = tool.modelProjection.kind === 'failure';
  const structuredSummary =
    structuredContent === undefined ? undefined : JSON.stringify({ structuredContent });
  const projectionTruncated =
    projectionFailed ||
    modelImages.length < images.length ||
    textBlocks.some((block, index) => modelText[index]?.text !== block.text) ||
    (structuredSummary !== undefined &&
      images.length === modelImages.length &&
      modelText.at(-1)?.text !== structuredSummary);
  const primaryBytes =
    textBlocks.reduce((sum, block) => sum + bytes(block.text), 0) +
    (structuredContent === undefined ? 0 : jsonBytes(structuredContent));
  if (primaryBytes !== requestedBytes)
    throw new Error('Synthetic MCP primary byte accounting mismatch');
  tool.wrapperMapping = {
    sourceCategory: 'mcp',
    materializedToolName: tool.toolName,
    mode: input.isError ? 'synthetic-snapshot' : 'native-mcp-normalized',
    reason: input.isError
      ? 'native-error-details-not-modeled'
      : 'native-provider-and-artifact-projection',
  };
  tool.byteAccounting = {
    ...tool.byteAccounting,
    requestedOutputBytes: requestedBytes,
    actualEmbeddedOutputBytes: primaryBytes,
    outputTextFields: content.flatMap((part, index) =>
      part.type === 'text' ? [`value.content[${index}].text`] : [],
    ),
    outputJsonFields: structuredContent === undefined ? [] : ['value.structuredContent'],
    resultJsonBytes: jsonBytes(tool.result),
    resultEnvelopeAndEscapingBytes: jsonBytes(tool.result) - primaryBytes,
    modelProjectionJsonBytes: jsonBytes(tool.modelProjection),
    projectionTruncated,
    mcp: {
      requestedTextPartBytes: [...shape.textPartBytes],
      actualTextPartBytes: textBlocks.map((block) => bytes(block.text)),
      requestedStructuredJsonBytes: shape.structuredJsonBytes,
      actualStructuredJsonBytes: structuredContent === undefined ? 0 : jsonBytes(structuredContent),
      excludedMetaJsonBytes: shape.excludedMetaJsonBytes,
      sourceResultJsonBytes: shape.sourceResultJsonBytes,
      sourceImageCount: shape.images.length,
      actualImageCount: images.length,
      imageBase64Chars: images.reduce((sum, image) => sum + image.block.data.length, 0),
      imageBinaryBytes: images.reduce(
        (sum, image) => sum + image.byteAccounting.actualBinaryBytes,
        0,
      ),
      projectedImageCount: projectionFailed ? 0 : modelImages.length,
      projectedTextBytes: projectionFailed
        ? 0
        : modelText.reduce((sum, part) => sum + bytes(part.text), 0),
      persistedImageBytes: projectionFailed
        ? 0
        : [
            ...new Map(artifactPlans.map((plan) => [plan.ref.relativePath, plan.bytes])).values(),
          ].reduce((a, b) => a + b, 0),
      projectionFailed,
      sourcePartInterleavingKnown: shape.contentOrder !== undefined,
    },
  };
  tool.mediaAccounting = images.map((image, index) => ({
    ...image.byteAccounting,
    contentBlockIndex: content.indexOf(image.block),
    retainedInModelProjection:
      !projectionFailed && modelImages.some((part) => part.data.data === image.block.data),
  }));
  tool.limitations.push(
    'MCP private _meta is excluded, as in the native manager normalization. Only its observed byte count is retained in the report. Text-part sizes and structured JSON sizes are separate from image bytes.',
  );
  if (images.length)
    tool.limitations.push(
      'MCP images are procedural test pictures with known dimensions and actual codec; legal padding matches encoded size where possible. Pixel entropy, visual content and decompression CPU cannot match the source screenshots.',
    );
  if (shape.contentOrder === undefined)
    tool.limitations.push(
      'Source part interleaving is unknown; synthetic text parts precede image parts.',
    );
  if (projectionTruncated)
    tool.limitations.push(
      'MCP model projection obeys native text/image/part limits; the full synthetic normalized result remains stored even when projection is clipped or fails.',
    );
  return tool;
}

/** Image-generation bytes become real fake media; image-view calls without
 * observed result pixels stay empty rather than inventing screenshot content. */
export async function buildFakeImageTool({ imageResult, ...input }) {
  if (input.category !== undefined && input.category !== 'image')
    throw new TypeError('Expected image category');
  if (input.outputBytes !== 0)
    throw new TypeError('Image-result base64 belongs in media shape, not text outputBytes');
  const shape = imageResult ?? { images: [], sourceResultBytes: 0 };
  if (!Array.isArray(shape.images)) throw new TypeError('Invalid image result shape');
  count(shape.sourceResultBytes, 'source image-result bytes', Number.MAX_SAFE_INTEGER);
  const tool = await buildFakeMcpTool({
    ...input,
    category: 'mcp',
    mcpShape: {
      textPartBytes: [],
      structuredJsonBytes: 0,
      images: shape.images,
      contentOrder: shape.images.map(() => 'image'),
      excludedMetaJsonBytes: 0,
      sourceResultJsonBytes: shape.sourceResultBytes,
    },
  });
  tool.toolName = shape.images.length
    ? 'mcp__fixture__image_result_snapshot'
    : 'mcp__fixture__image_view_snapshot';
  tool.args = paddedArguments(
    {},
    shape.images.length ? 'prompt' : 'description',
    input.argumentBytes,
    'plain',
    input.ordinal ?? 0,
  );
  tool.wrapperMapping = {
    sourceCategory: 'image',
    materializedToolName: tool.toolName,
    mode: 'synthetic-snapshot',
    reason: shape.images.length
      ? 'synthetic-media-for-observed-image-result'
      : 'no-observed-image-result-pixels',
  };
  tool.byteAccounting.actualArgumentsJsonBytes = jsonBytes(tool.args);
  tool.byteAccounting.argumentJsonDeltaBytes = jsonBytes(tool.args) - input.argumentBytes;
  tool.byteAccounting.imageResult = {
    sourceResultBytes: shape.sourceResultBytes,
    observedImageCount: shape.images.length,
    actualImageCount: tool.mediaAccounting.length,
  };
  return tool;
}
