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

// Run after the workspace build, with the same Node release as the desktop Host:
//   node scripts/perf/startup-fixture.mjs --pilot
//   node scripts/perf/startup-fixture.mjs --config scripts/perf/startup-fixtures/local-usage.json
// Existing fixture directories are deliberately never overwritten. --name permits
// a new experiment. No real content, credentials, project paths or thread IDs are
// copied: only source-independent numeric histograms enter this program.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { gunzipSync } from 'node:zlib';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  buildInvocationOpenedEvent,
  buildSyntheticTerminalRuntimeEvent,
} from '@maka/core/runtime-invocation';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { DEFAULT_TOOL_MODE } from '@maka/core/tool-mode';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  resolveRootControlNamespace,
} from '@maka/storage/root-authority';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { createProjectCatalog } from '@maka/storage/project-catalog';
import { createSettingsStore } from '@maka/storage/settings-store';
import { OPERATIONAL_STATE_DATABASE_NAME } from '@maka/storage/operational-state-store';
import {
  projectRuntimeEventsToStoredMessages,
  isHardRuntimeEventReadModelDiagnostic,
} from '../../packages/runtime/dist/runtime-event-read-model.js';
import { buildScenario } from './startup-scenario.mjs';
import { shapeTerminalResult } from '@maka/runtime/shell-tools';
import {
  fakeMessageText,
  shapeStatistics,
  planReasoningAnchors,
} from './startup-shaped-scenario.mjs';
import { buildFakeTool, buildFakeMcpTool, buildFakeImageTool } from './startup-fixture-tools.mjs';
import { createFakeAttachment } from './startup-fixture-media.mjs';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactRoot = join(repoRoot, 'artifacts/startup-baseline');
const options = parseOptions(process.argv.slice(2));
const fixtureRoot = join(artifactRoot, 'fixtures', options.name);
const userDataDir = join(fixtureRoot, 'user-data');
const workspaceRoot = join(userDataDir, 'workspaces/default');
const homeDir = join(fixtureRoot, 'home');
const modelId = 'claude-sonnet-4-5-20250929';
const connectionSlug = 'startup-synthetic';
const seedStarted = performance.now();
const recipeBytes = await readFile(resolve(options.config));
const constructorHash = createHash('sha256');
for (const file of [
  'startup-fixture.mjs',
  'startup-scenario.mjs',
  'startup-shaped-scenario.mjs',
  'startup-fixture-tools.mjs',
  'startup-fixture-media.mjs',
])
  constructorHash.update(await readFile(new URL(file, import.meta.url)));
const implementation = {
  makaCommit:
    process.env.MAKA_BENCH_COMMIT ??
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim(),
  constructorSha256: constructorHash.digest('hex'),
  recipeSha256: createHash('sha256').update(recipeBytes).digest('hex'),
};
const config = JSON.parse(
  (options.config.endsWith('.gz') ? gunzipSync(recipeBytes) : recipeBytes).toString('utf8'),
);
const scenario = buildScenario(config);
const sessions = [];
const pending = new Map(scenario.sessions.map((session) => [session.id, session]));
while (pending.size) {
  const ready = [...pending.values()].filter(
    (session) => !session.parentId || !pending.has(session.parentId),
  );
  assert(ready.length, 'Parent ordering did not progress');
  for (const session of ready) {
    sessions.push(session);
    pending.delete(session.id);
  }
}
if (options.planOnly) {
  console.log(JSON.stringify({ fingerprint: scenario.fingerprint, ...scenario.summary }, null, 2));
  process.exit(0);
}

await mkdir(join(artifactRoot, 'fixtures'), { recursive: true });
assert.equal(
  await realpath(artifactRoot),
  artifactRoot,
  'Artifact directory must not be a symlink',
);
assert(!relative(repoRoot, fixtureRoot).startsWith(`..${sep}`));
await mkdir(fixtureRoot); // EEXIST is intentional: never replace a measured profile.
await mkdir(workspaceRoot, { recursive: true });
await mkdir(homeDir);
await createSettingsStore(workspaceRoot).update({ personalization: { uiLocale: 'zh-CN' } });

const capability = await resolveStorageRoot({ path: workspaceRoot, kind: 'interactive' });
const owner = await tryAcquireInteractiveRootOwner(capability);
assert(owner, 'Could not acquire the isolated fixture root');
const sessionMap = [];
let catalog;
let artifactStore;
let totals = {
  sessions: 0,
  archived: 0,
  turns: 0,
  tools: 0,
  events: 0,
  payloadBytes: 0,
  placeholderPrompts: 0,
};
const physicalSessions = new Map();
const physicalIds = new Map(scenario.sessions.map((session) => [session.id, randomUUID()]));
const workspaceProjectOwner = new Map();
for (const session of scenario.sessions) {
  if (
    !workspaceProjectOwner.has(session.workspaceIndex) ||
    workspaceProjectOwner.get(session.workspaceIndex) === null
  )
    workspaceProjectOwner.set(session.workspaceIndex, session.projectIndex);
}
try {
  const connectionId = await seedConnection(owner.lease);
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  if (scenario.schemaVersion === 2)
    artifactStore = await openInteractiveArtifactStoreForWrite(owner.lease);
  catalog = createProjectCatalog(workspaceRoot);
  const projects = new Map();
  const now = Date.now();
  for (let index = 0; index < sessions.length; index += 1) {
    const descriptor = sessions[index];
    const projectKey = descriptor.projectIndex;
    if (projectKey !== null && !projects.has(projectKey)) {
      const projectPath = join(fixtureRoot, 'projects', `project-${projectKey}`);
      await mkdir(projectPath, { recursive: true });
      await writeFile(join(projectPath, 'README.md'), 'Synthetic startup benchmark workspace.\n');
      const project = await catalog.register(projectPath, { withinRoot: fixtureRoot });
      projects.set(projectKey, { id: project.id, path: projectPath });
    }
    const project = projects.get(projectKey);
    const directoryProject = workspaceProjectOwner.get(descriptor.workspaceIndex);
    const cwd = join(
      directoryProject === null
        ? join(fixtureRoot, 'projectless')
        : join(fixtureRoot, 'projects', `project-${directoryProject}`),
      `workspace-${descriptor.workspaceIndex}`,
    );
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(cwd, 'README.md'),
      'Synthetic constructor workspace; no real user content.\n',
    );
    const parent = descriptor.parentId ? physicalSessions.get(descriptor.parentId) : undefined;
    assert(!descriptor.parentId || parent, 'Parent must be materialized before child');
    const createInput = {
      cwd,
      projectId: project?.id ?? null,
      llmConnectionId: connectionId,
      llmConnectionSlug: connectionSlug,
      model: modelId,
      permissionMode: 'ask',
      name: descriptor.name ?? `Startup fixture ${String(index + 1).padStart(4, '0')}`,
      labels: [],
      ...(parent
        ? {
            subagentParent: {
              kind: 'subagent',
              parentSessionId: parent.sessionId,
              spawnedBy: {
                ...(scenario.schemaVersion === 2
                  ? lineageIdentity(descriptor)
                  : {
                      parentRunId: parent.firstToolRunId,
                      parentTurnId: parent.firstToolTurnId,
                      toolCallId: parent.firstToolCallId,
                    }),
              },
              lifecycle: 'foreground',
            },
          }
        : {}),
    };
    const creation = await stores.sessionStore.createStableSession({
      sessionId: physicalIds.get(descriptor.id),
      requestFingerprint: canonicalToolArgsHash('fixture.session.create', {
        scenario: scenario.fingerprint,
        id: descriptor.id,
      }),
      input: createInput,
    });
    assert.equal(creation.kind, 'created');
    const session = creation.record.header;
    const lastAt = now - descriptor.ageMinutes * 60_000;
    const statistics = await (scenario.schemaVersion === 2 ? seedShapedSession : seedNativeSession)(
      stores.runtimeEventStore,
      session.id,
      descriptor,
      {
        connectionId,
        cwd,
        lastAt,
        artifactStore,
        seed: scenario.seed,
        physicalIds,
        children: scenario.sessions.filter((s) => s.parentId === descriptor.id),
      },
    );
    await stores.sessionStore.updateHeader(session.id, {
      createdAt: lastAt - Math.max(1, descriptor.turns.length) * 60_000,
      lastMessageAt: descriptor.turns.length > 0 ? lastAt : undefined,
      connectionLocked: descriptor.turns.length > 0,
      status: 'active',
      statusUpdatedAt: lastAt,
    });
    if (descriptor.archived) {
      const record = await stores.sessionStore.readHeaderRecordSnapshot(session.id);
      await stores.sessionStore.setSessionsArchivedVersioned(
        [{ sessionId: session.id, expectedVersion: record.revision }],
        true,
      );
    }
    if (descriptor.pinned) await stores.sessionStore.setFlagged(session.id, true);
    // Validate through the same native read surface the Host uses, before close.
    const invocations = await stores.runtimeEventStore.listSessionInvocations(session.id);
    assert.equal(
      invocations.length,
      descriptor.turns.length + (statistics.syntheticLineageAnchors ?? 0),
    );
    assert.deepEqual(
      invocations
        .filter((invocation) => !invocation.invocationId.includes('_lineage_'))
        .map((invocation) => invocation.terminalEvent?.status),
      descriptor.turns.map((turn) => turn.status),
    );
    for (const invocation of invocations) {
      const projection = projectRuntimeEventsToStoredMessages(
        await stores.runtimeEventStore.readRuntimeEvents(session.id, invocation.runId),
        { invocations: [invocation] },
      );
      assert.deepEqual(
        projection.diagnostics.filter(isHardRuntimeEventReadModelDiagnostic),
        [],
        'Native history must project without hard diagnostics',
      );
    }
    assert.equal(
      (await stores.runtimeEventStore.listUnsettledToolOperations(session.id)).length,
      0,
    );
    const header = await stores.sessionStore.readHeader(session.id);
    assert.equal(header.transcriptLedgerVersion, 1);
    assert.equal(header.isArchived, Boolean(descriptor.archived));
    sessionMap.push({
      syntheticId: descriptor.id,
      sessionId: session.id,
      name: session.name,
      archived: Boolean(descriptor.archived),
      parentSessionId: parent?.sessionId ?? null,
      projectIndex: projectKey,
      ...statistics,
    });
    physicalSessions.set(descriptor.id, { sessionId: session.id, ...statistics });
    for (const key of ['turns', 'tools', 'events', 'payloadBytes', 'placeholderPrompts'])
      totals[key] += statistics[key];
    totals.sessions += 1;
    totals.archived += Number(Boolean(descriptor.archived));
    if ((index + 1) % 10 === 0 || index + 1 === sessions.length) {
      process.stderr.write(
        `[startup-fixture] ${index + 1}/${sessions.length} sessions; ${totals.tools} native tools; ${(totals.payloadBytes / 1048576).toFixed(1)} MiB synthetic payload\n`,
      );
    }
  }
} finally {
  catalog?.close();
  await artifactStore?.close();
  await owner.close();
}

const databasePath = join(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME);
const database = new DatabaseSync(databasePath, { readOnly: true });
let integrity;
let tableCounts;
try {
  integrity = database.prepare('PRAGMA integrity_check').all();
  assert.deepEqual(
    integrity.map((row) => row.integrity_check),
    ['ok'],
  );
  tableCounts = {};
  for (const { name } of database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    if (/session|runtime|tool|invocation|admission/.test(name)) {
      tableCounts[name] = database
        .prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`)
        .get().n;
    }
  }
} finally {
  database.close();
}
const manifest = {
  schemaVersion: 1,
  kind: 'native-settled-synthetic-fixture',
  generatedAt: new Date().toISOString(),
  recipe: relative(repoRoot, resolve(options.config)),
  scenarioFingerprint: scenario.fingerprint,
  requested: scenario.summary,
  implementation,
  userDataDir,
  workspaceRoot,
  homeDir,
  registrationPath: join(resolveRootControlNamespace(), capability.rootId, 'registration.json'),
  seedMs: Math.round(performance.now() - seedStarted),
  totals,
  selectedSessionId: physicalSessions.get(scenario.selectedSessionId)?.sessionId ?? null,
  selectedTurnId:
    physicalSessions.get(scenario.selectedSessionId)?.lastRenderableTurnId ??
    physicalSessions.get(scenario.selectedSessionId)?.lastTurnId ??
    null,
  expectedActiveSessions: totals.sessions - totals.archived,
  databaseBytes: (await stat(databasePath)).size,
  integrity,
  tableCounts,
  limitations:
    scenario.schemaVersion === 2
      ? [
          'V2 preserves every observed user session/turn/item sequence, byte target, tool error, archive flag, project/workspace and parent relation; internal guardian helpers are excluded.',
          'All generated text, names, paths, commands, images and native identities are fake. Only numeric structure and enums are accepted by the constructor.',
          'Source inProgress turns are explicitly materialized as aborted historical snapshots; this is not an in-flight or crash-recovery simulation.',
          'Only source-proven spawn positions are reused. Unknown trigger positions need separately counted synthetic lineage invocations so Maka child metadata has a valid tool boundary; they are not claimed as observed tools.',
          'A reasoning segment only attaches to its immediately following assistant; segments ending at another boundary receive an empty carrier so tool interleaving survives the UI timeline. No user messages are invented. Non-native notes have explicit labels counted as overhead.',
          'Tool output primary bytes are checked after native persistence. Valid Maka argument schemas can have different serialized size, reported separately. JSON envelopes/model projections are additional bytes.',
          'Edit is a native diff-preview result via a synthetic tool, not a real managed mutation. Full graph claims, workspace reservations and provider attempts are not created.',
          'User image attachment counts use synthetic 960x600 PNGs because source dimensions were not observed. Known MCP/generated result images preserve actual codec and dimensions; encoded size differences, legal padding and projection retention are recorded per image. Source imageView pixels are not copied or invented.',
          'MCP content order, text blocks and structured JSON have separate budgets; private source metadata is excluded. Production model projection limits remain in effect. Synthetic image entropy and CPU decoding cost cannot reproduce real screenshots.',
          'Current Maka UI requires restoring an archived task before opening its transcript. Archived longest workloads remain archived and are validated through native read APIs instead.',
        ]
      : [
          'Independent numeric recipe only. The constructor never reads Codex storage or imports another product database.',
          'All identities, projects, paths, titles, arguments and payloads are newly synthetic. Histogram totals match the recipe; text entropy and exact historical order are not reproduced.',
          'Within-turn counts and session turn-count distribution are retained, but independently shuffled with a reproducible seed; no real conversation is reconstructed.',
          'All tools are settled; invocation terminal states include completed/failed/aborted. In-flight recovery fixtures are intentionally deferred.',
          'Tool categories become Bash, Read, Grep or synthetic MCP names with replay_safe fixture ledgers. No real commands/tools execute; managed workspace mutations, image binaries and external side effects are not synthesized.',
          'Subagent parent metadata references existing synthetic parent tool boundaries. Full agent-graph provision/claim/worktree execution history is not synthesized.',
          'A minimal prompt/assistant carrier is added when Maka presentation requires it. Root admission, provider attempt, usage, permission and diagnostic auxiliary ledgers are not synthesized.',
          'Projects are local synthetic directories; Git repositories, file trees, skills, plugins and network services are not cloned.',
          'Settings and model catalog are valid local fixtures with a placeholder credential; no provider request is needed or authorized.',
        ],
  sessionMap,
  showcases: scenario.showcases
    ? Object.fromEntries(
        Object.entries(scenario.showcases).map(([label, entry]) => [
          label,
          {
            ...entry,
            ...physicalSessions.get(entry.id),
            name: sessionMap.find((s) => s.syntheticId === entry.id)?.name,
          },
        ]),
      )
    : undefined,
};
await writeFile(join(fixtureRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(fixtureRoot, 'scenario.json'), `${JSON.stringify(scenario)}\n`);
process.stdout.write(
  `${JSON.stringify({ fixtureRoot, manifest: join(fixtureRoot, 'manifest.json'), ...totals, databaseBytes: manifest.databaseBytes, seedMs: manifest.seedMs }, null, 2)}\n`,
);

function parseOptions(args) {
  const parsed = {
    pilot: false,
    planOnly: false,
    config: 'scripts/perf/startup-fixtures/local-usage-v2.json',
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--pilot') parsed.pilot = true;
    else if (arg === '--plan-only') parsed.planOnly = true;
    else if (['--config', '--name'].includes(arg)) {
      assert(args[index + 1], 'Missing value for ' + arg);
      parsed[arg.slice(2)] = args[++index];
    } else throw new Error('Unknown argument: ' + arg);
  }
  if (parsed.pilot) parsed.config = 'scripts/perf/startup-fixtures/smoke-v2.json';
  parsed.name ??= parsed.pilot ? 'constructor-smoke-v2' : 'local-usage-shaped-v2';
  assert(
    /^[a-z0-9][a-z0-9-]{0,79}$/.test(parsed.name),
    'Fixture name must be a lowercase basename',
  );
  return parsed;
}

async function seedNativeSession(runtime, sessionId, descriptor, context) {
  const statistics = {
    turns: descriptor.turns.length,
    tools: 0,
    events: 0,
    payloadBytes: 0,
    placeholderPrompts: 0,
    assistantCarriers: 0,
  };
  const batches = [];
  const content = (bytes, marker) => {
    assert(Number.isSafeInteger(bytes) && bytes >= 0, 'Invalid payload size');
    statistics.payloadBytes += bytes;
    return marker.repeat(Math.ceil(bytes / marker.length)).slice(0, bytes);
  };
  for (let turnIndex = 0; turnIndex < descriptor.turns.length; turnIndex++) {
    const turn = descriptor.turns[turnIndex];
    const prefix = descriptor.id + '_t' + turnIndex;
    const run = {
      sessionId,
      runId: prefix + '_run',
      invocationId: prefix + '_invocation',
      turnId: prefix + '_turn',
    };
    statistics.lastTurnId = run.turnId;
    let sequence = 0;
    const startedAt = Math.floor(context.lastAt - (descriptor.turns.length - turnIndex) * 60000);
    const event = (fields) => ({
      id: prefix + '_e' + ++sequence,
      ...run,
      ts: startedAt + sequence,
      partial: false,
      ...fields,
    });
    const events = [];
    const append = async (value) => {
      events.push(value);
      statistics.events++;
    };
    await append(
      buildInvocationOpenedEvent({
        id: prefix + '_opened',
        run,
        openedAt: startedAt,
        opening: {
          kind: 'invocation_opened',
          protocol: 'invocation_opened_v1',
          route: {
            provenance: 'runtime',
            backendKind: 'ai-sdk',
            llmConnectionId: context.connectionId,
            llmConnectionSlug: connectionSlug,
            modelId,
          },
          configuration: {
            cwd: context.cwd,
            permissionMode: 'ask',
            collaborationMode: 'agent',
            orchestrationMode: 'default',
            orchestrationSource: 'session',
            toolMode: DEFAULT_TOOL_MODE,
          },
          root: { kind: 'user' },
          source: { kind: 'fresh' },
        },
      }),
    );
    const prompts = [...turn.user];
    if (!prompts.length) {
      prompts.push(32);
      statistics.placeholderPrompts++;
    }
    for (const bytes of prompts)
      await append(
        event({
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: content(Math.max(1, bytes), 'Synthetic prompt. ') },
        }),
      );
    const answerId = prefix + '_assistant';
    for (const bytes of turn.reasoning)
      await append(
        event({
          role: 'model',
          author: 'agent',
          refs: { providerEventId: answerId },
          content: { kind: 'thinking', text: content(bytes, 'Synthetic reasoning. ') },
        }),
      );
    for (let toolIndex = 0; toolIndex < turn.tools.length; toolIndex++) {
      const tool = turn.tools[toolIndex];
      const toolName =
        tool.kind === 'command'
          ? 'Bash'
          : tool.kind === 'search'
            ? 'Grep'
            : ['mcp', 'web', 'delegate', 'image'].includes(tool.kind)
              ? 'mcp__fixture__' + tool.kind
              : 'Read';
      const operationId = prefix + '_op' + toolIndex,
        providerToolCallId = operationId + '_call';
      const argumentPayload = content(tool.argumentBytes, 'synthetic_argument ');
      const args =
        toolName === 'Bash'
          ? {
              command: argumentPayload || 'printf synthetic',
              description: 'Synthetic fixture; never executed',
            }
          : toolName === 'Read'
            ? {
                path: join(context.cwd, 'README.md'),
                syntheticPayload: argumentPayload,
                category: tool.kind,
              }
            : { syntheticPayload: argumentPayload };
      const canonicalArgsHash = canonicalToolArgsHash(toolName, args);
      const refs = { operationId, toolCallId: providerToolCallId };
      const call = event({
        role: 'model',
        author: 'agent',
        refs,
        content: { kind: 'function_call', id: providerToolCallId, name: toolName, args },
      });
      const dispatch = event({
        role: 'system',
        author: 'system',
        refs,
        actions: {
          toolDispatch: {
            protocol: runtime.toolBoundaryProtocol,
            resultProjectionVersion: 1,
            operationId,
            providerToolCallId,
            toolName,
            canonicalArgsHash,
            recoveryMode: 'replay_safe',
          },
        },
      });
      events.push(call, dispatch);
      const output = content(tool.outputBytes, 'Synthetic output line.\n');
      const result =
        toolName === 'Bash'
          ? shapeTerminalResult({
              cwd: context.cwd,
              command: args.command,
              result: { stdout: output, stderr: '', exitCode: 0 },
            })
          : { kind: 'text', text: output };
      const outcome = event({
        role: 'tool',
        author: 'tool',
        refs,
        content: {
          kind: 'function_response',
          id: providerToolCallId,
          name: toolName,
          result,
          modelProjection: { version: 1, kind: 'text', text: 'Synthetic settled tool result.' },
        },
      });
      events.push(outcome);
      statistics.tools++;
      statistics.events += 3;
      if (!statistics.firstToolCallId)
        Object.assign(statistics, {
          firstToolCallId: providerToolCallId,
          firstToolRunId: run.runId,
          firstToolTurnId: run.turnId,
        });
    }
    const answers = [...turn.assistant];
    if (!answers.length && turn.reasoning.length) {
      answers.push(1);
      statistics.assistantCarriers++;
    }
    for (let index = 0; index < answers.length; index++)
      await append(
        event({
          role: 'model',
          author: 'agent',
          refs: { providerEventId: index === 0 ? answerId : answerId + '_' + index },
          content: {
            kind: 'text',
            text: content(Math.max(1, answers[index]), 'Synthetic answer. '),
          },
        }),
      );
    await append(
      event({
        role: 'system',
        author: 'system',
        status: turn.status,
        actions: { endInvocation: true },
        ...(turn.status === 'failed'
          ? {
              content: {
                kind: 'error',
                code: 'synthetic_failure',
                message: 'Synthetic settled failure.',
              },
            }
          : {}),
      }),
    );
    batches.push({ runId: run.runId, events });
  }
  // Existing Maka bulk-canonical writer checks identities and the tool ledger,
  // commits in one session transaction, then rebuilds native tool projections.
  // These events are generated here; this is not importing another app's data.
  // Seeding is outside the measured startup, so do not replay each historical
  // T1/T2 individually (that would rescan growing prefixes quadratically).
  await runtime.importConversationCopyRuntimeEvents(sessionId, batches);
  return statistics;
}

async function seedShapedSession(runtime, sessionId, descriptor, context) {
  const statistics = {
    turns: descriptor.turns.length,
    tools: 0,
    events: 0,
    payloadBytes: 0,
    placeholderPrompts: 0,
    assistantCarriers: 0,
    sourceShape: shapeStatistics(descriptor),
    toolErrors: 0,
    imageAttachments: 0,
    mcpMedia: [],
    notes: 0,
    requestedArgumentBytes: 0,
    actualArgumentJsonBytes: 0,
    requestedOutputBytes: 0,
    embeddedOutputBytes: 0,
    resultJsonBytes: 0,
    modelProjectionJsonBytes: 0,
    projectionTruncations: 0,
    verifiedSourceItems: 0,
    formatDisplayOverheadBytes: 0,
    toolMappings: {},
  };
  const batches = [],
    checks = [],
    limitations = new Set();
  for (let turnIndex = 0; turnIndex < descriptor.turns.length; turnIndex++) {
    const turn = descriptor.turns[turnIndex],
      prefix = descriptor.id + '_t' + turnIndex;
    const run = {
      sessionId,
      runId: prefix + '_run',
      invocationId: prefix + '_invocation',
      turnId: prefix + '_turn',
    };
    statistics.lastTurnId = run.turnId;
    if (
      turn.items.some(
        (i) =>
          i.kind === 'tool' || i.kind === 'note' || i.bytes > 0 || i.formatHints?.imageAttachments,
      )
    )
      statistics.lastRenderableTurnId = run.turnId;
    const startedAt = Math.floor(context.lastAt - (descriptor.turns.length - turnIndex) * 60000);
    let sequence = 0,
      previousAssistant;
    const reasoningAnchors = planReasoningAnchors(turn.items, prefix);
    const events = [],
      turnChecks = [];
    const event = (id, fields) => ({
      id,
      ...run,
      ts: startedAt + ++sequence,
      partial: false,
      ...fields,
    });
    events.push(
      buildInvocationOpenedEvent({
        id: prefix + '_opened',
        run,
        openedAt: startedAt,
        opening: {
          kind: 'invocation_opened',
          protocol: 'invocation_opened_v1',
          route: {
            provenance: 'runtime',
            backendKind: 'ai-sdk',
            llmConnectionId: context.connectionId,
            llmConnectionSlug: connectionSlug,
            modelId,
          },
          configuration: {
            cwd: context.cwd,
            permissionMode: 'ask',
            collaborationMode: 'agent',
            orchestrationMode: 'default',
            orchestrationSource: 'session',
            toolMode: DEFAULT_TOOL_MODE,
          },
          root: { kind: 'user' },
          source: { kind: 'fresh' },
        },
      }),
    );
    for (let index = 0; index < turn.items.length; index++) {
      const item = turn.items[index],
        id = prefix + '_item' + index;
      const ordinal =
        (Number(descriptor.id.slice(-4)) * 100000 + turnIndex * 3000 + index + context.seed) %
        1000000000;
      if (item.kind === 'tool') {
        const tool = await (item.mcp
          ? buildFakeMcpTool
          : item.category === 'image'
            ? buildFakeImageTool
            : buildFakeTool)({
          category: item.category,
          argumentBytes: item.argumentBytes,
          outputBytes: item.outputBytes,
          isError: item.isError,
          formatHint: item.formatHint,
          subtype: item.subtype,
          ordinal,
          cwd: context.cwd,
          fixtureId: descriptor.id,
          mcpShape: item.mcp,
          imageResult: item.imageResult,
          artifactStore: context.artifactStore,
          sessionId,
          turnId: run.turnId,
        });
        const operationId = id + '_operation',
          toolCallId = id + '_call';
        const refs = { operationId, toolCallId };
        const hash = canonicalToolArgsHash(tool.toolName, tool.args);
        events.push(
          event(toolCallId, {
            role: 'model',
            author: 'agent',
            refs: { ...refs, ...(previousAssistant ? { stepId: previousAssistant } : {}) },
            actions: { stateDelta: { activityKind: tool.activityKind } },
            content: {
              kind: 'function_call',
              id: toolCallId,
              name: tool.toolName,
              args: tool.args,
            },
          }),
        );
        events.push(
          event(id + '_dispatch', {
            role: 'system',
            author: 'system',
            refs,
            actions: {
              toolDispatch: {
                protocol: runtime.toolBoundaryProtocol,
                resultProjectionVersion: 1,
                operationId,
                providerToolCallId: toolCallId,
                toolName: tool.toolName,
                canonicalArgsHash: hash,
                recoveryMode: tool.recoveryMode,
              },
            },
          }),
        );
        if (item.childIds?.length && tool.result.kind === 'subagent') {
          tool.result.childSessionId = context.physicalIds.get(item.childIds[0]);
          if (tool.modelProjection.kind === 'json') tool.modelProjection.value = { ...tool.result };
          tool.byteAccounting.resultJsonBytes = Buffer.byteLength(JSON.stringify(tool.result));
          tool.byteAccounting.modelProjectionJsonBytes = Buffer.byteLength(
            JSON.stringify(tool.modelProjection),
          );
        }
        events.push(
          event(id + '_outcome', {
            role: 'tool',
            author: 'tool',
            refs,
            content: {
              kind: 'function_response',
              id: toolCallId,
              name: tool.toolName,
              result: tool.result,
              isError: tool.isError,
              modelProjection: tool.modelProjection,
            },
          }),
        );
        const accounting = tool.byteAccounting;
        statistics.mcpMedia.push(...(tool.mediaAccounting ?? []));
        statistics.tools++;
        statistics.toolErrors += Number(item.isError);
        const mappingKey =
          item.category +
          ':' +
          (tool.wrapperMapping?.mode ?? 'synthetic-adapter') +
          ':' +
          tool.toolName;
        statistics.toolMappings[mappingKey] = (statistics.toolMappings[mappingKey] ?? 0) + 1;
        statistics.requestedArgumentBytes += item.argumentBytes;
        statistics.actualArgumentJsonBytes += accounting.actualArgumentsJsonBytes;
        statistics.requestedOutputBytes += item.outputBytes;
        statistics.embeddedOutputBytes += accounting.actualEmbeddedOutputBytes;
        statistics.resultJsonBytes += accounting.resultJsonBytes;
        statistics.modelProjectionJsonBytes += accounting.modelProjectionJsonBytes;
        statistics.projectionTruncations += Number(accounting.projectionTruncated);
        statistics.payloadBytes += item.argumentBytes + item.outputBytes;
        for (const note of tool.limitations) limitations.add(note);
        turnChecks.push({
          kind: 'tool',
          firstEventId: toolCallId,
          resultEventId: id + '_outcome',
          expectedOutputBytes: item.outputBytes,
          paths: accounting.outputTextFields,
          jsonPaths: accounting.outputJsonFields ?? [],
          isError: item.isError,
        });
        if (!statistics.firstToolCallId)
          Object.assign(statistics, {
            firstToolCallId: toolCallId,
            firstToolRunId: run.runId,
            firstToolTurnId: run.turnId,
          });
      } else if (item.kind === 'note') {
        statistics.notes++;
        statistics.payloadBytes += item.bytes;
        if (item.subtype === 'compaction')
          events.push(
            event(id, {
              role: 'system',
              author: 'system',
              content: {
                kind: 'system_note',
                note: 'context_compacted',
                data: {
                  synthetic: true,
                  summary: fakeMessageText(item.bytes, { kind: 'compaction', ordinal }),
                },
              },
            }),
          );
        else {
          const label = `[Synthetic ${item.subtype}]\n`;
          const text = fakeMessageText(item.bytes, { kind: item.subtype, ordinal });
          events.push(
            event(id, {
              role: 'model',
              author: 'agent',
              refs: { providerEventId: id },
              content: { kind: 'text', text: label + text },
            }),
          );
          statistics.formatDisplayOverheadBytes += Buffer.byteLength(label);
        }
        turnChecks.push({
          kind: 'note',
          firstEventId: id,
          expectedTextBytes: item.bytes,
          subtype: item.subtype,
        });
      } else {
        const text = fakeMessageText(item.bytes, {
          kind: item.kind,
          ordinal,
          formatHints: item.formatHints,
        });
        let refs = { providerEventId: id };
        if (item.kind === 'reasoning') {
          refs = { providerEventId: reasoningAnchors.get(index).providerEventId };
        }
        const attachments = [];
        if (item.kind === 'user')
          for (let a = 0; a < (item.formatHints?.imageAttachments ?? 0); a++) {
            const media = await createFakeAttachment({
              artifactStore: context.artifactStore,
              sessionId,
              ordinal: ordinal * 10 + a,
              now: startedAt + sequence,
            });
            attachments.push(media.attachment);
            statistics.imageAttachments++;
          }
        events.push(
          event(id, {
            role: item.kind === 'user' ? 'user' : 'model',
            author: item.kind === 'user' ? 'user' : 'agent',
            refs,
            content:
              item.kind === 'reasoning'
                ? { kind: 'thinking', text }
                : { kind: 'text', text, ...(attachments.length ? { attachments } : {}) },
          }),
        );
        if (item.kind === 'assistant') previousAssistant = id;
        if (reasoningAnchors.get(index)?.carrierAfter) {
          const carrierId = reasoningAnchors.get(index).providerEventId;
          events.push(
            event(carrierId, {
              role: 'model',
              author: 'agent',
              refs: { providerEventId: carrierId },
              content: { kind: 'text', text: '' },
            }),
          );
          previousAssistant = carrierId;
          statistics.assistantCarriers++;
        }
        statistics.payloadBytes += item.bytes;
        turnChecks.push({
          kind: item.kind,
          firstEventId: id,
          expectedTextBytes: item.bytes,
          attachments: attachments.length,
        });
      }
    }
    events.push(
      buildSyntheticTerminalRuntimeEvent({
        id: prefix + '_terminal',
        invocationId: run.invocationId,
        run,
        status: turn.status === 'aborted' ? 'cancelled' : turn.status,
        ts: startedAt + ++sequence,
        failureClass: 'synthetic_failure',
        abortSource: 'synthetic_interruption',
      }),
    );
    statistics.events += events.length;
    batches.push({ runId: run.runId, events });
    checks.push({ runId: run.runId, items: turnChecks });
  }
  statistics.syntheticLineageAnchors = 0;
  for (const child of context.children.filter((child) => child.parentTurnIndex === undefined)) {
    const identity = lineageIdentity(child),
      prefix = identity.parentRunId.replace(/_run$/, '');
    const run = {
      sessionId,
      runId: identity.parentRunId,
      turnId: identity.parentTurnId,
      invocationId: prefix + '_invocation',
    };
    const ts = Math.floor(
      context.lastAt -
        (descriptor.turns.length + 100) * 60000 +
        statistics.syntheticLineageAnchors * 10,
    );
    const args = {
      task: 'Synthetic relationship anchor: source spawn item was not available.',
      childSessionId: context.physicalIds.get(child.id),
    };
    const operationId = prefix + '_operation',
      toolCallId = identity.toolCallId,
      toolName = 'mcp__fixture__lineage_anchor',
      refs = { operationId, toolCallId };
    const opening = buildInvocationOpenedEvent({
      id: prefix + '_opened',
      run,
      openedAt: ts,
      opening: {
        kind: 'invocation_opened',
        protocol: 'invocation_opened_v1',
        route: {
          provenance: 'runtime',
          backendKind: 'ai-sdk',
          llmConnectionId: context.connectionId,
          llmConnectionSlug: connectionSlug,
          modelId,
        },
        configuration: {
          cwd: context.cwd,
          permissionMode: 'ask',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
          orchestrationSource: 'session',
          toolMode: DEFAULT_TOOL_MODE,
        },
        root: { kind: 'user' },
        source: { kind: 'fresh' },
      },
    });
    const envelope = (id, offset, fields) => ({
      id,
      ...run,
      ts: ts + offset,
      partial: false,
      ...fields,
    });
    const events = [
      opening,
      envelope(toolCallId, 1, {
        role: 'model',
        author: 'agent',
        refs,
        content: { kind: 'function_call', id: toolCallId, name: toolName, args },
      }),
      envelope(prefix + '_dispatch', 2, {
        role: 'system',
        author: 'system',
        refs,
        actions: {
          toolDispatch: {
            protocol: runtime.toolBoundaryProtocol,
            resultProjectionVersion: 1,
            operationId,
            providerToolCallId: toolCallId,
            toolName,
            canonicalArgsHash: canonicalToolArgsHash(toolName, args),
            recoveryMode: 'never_auto_retry',
          },
        },
      }),
      envelope(prefix + '_outcome', 3, {
        role: 'tool',
        author: 'tool',
        refs,
        content: {
          kind: 'function_response',
          id: toolCallId,
          name: toolName,
          result: {
            kind: 'subagent',
            agentName: 'Synthetic relation anchor',
            turnId: run.turnId,
            childSessionId: args.childSessionId,
            status: 'completed',
            permissionMode: 'explore',
            summary: 'Synthetic compatibility record; not an observed source tool call.',
            artifactIds: [],
          },
          modelProjection: {
            version: 1,
            kind: 'text',
            text: 'Synthetic compatibility relation only.',
          },
        },
      }),
      buildSyntheticTerminalRuntimeEvent({
        id: prefix + '_terminal',
        invocationId: run.invocationId,
        run,
        status: 'completed',
        ts: ts + 4,
      }),
    ];
    batches.push({ runId: run.runId, events });
    statistics.events += events.length;
    statistics.syntheticLineageAnchors++;
  }
  await runtime.importConversationCopyRuntimeEvents(sessionId, batches);
  // Read the committed native data back. This checks order and actual stored
  // primary bytes, not two counters computed from the same input recipe.
  for (const check of checks) {
    const native = await runtime.readRuntimeEvents(sessionId, check.runId),
      byId = new Map(native.map((e) => [e.id, e]));
    const firstIds = new Set(check.items.map((item) => item.firstEventId));
    assert.deepEqual(
      native.filter((e) => firstIds.has(e.id)).map((e) => e.id),
      check.items.map((i) => i.firstEventId),
      'Native source item order drifted',
    );
    for (const item of check.items) {
      const stored = byId.get(item.firstEventId);
      assert(stored);
      if (item.kind === 'tool') {
        const outcome = byId.get(item.resultEventId);
        assert(outcome);
        assert.equal(Boolean(outcome.content.isError), item.isError);
        assert.equal(
          item.paths.reduce((n, path) => n + textBytesAt(outcome.content.result, path), 0) +
            item.jsonPaths.reduce(
              (n, path) => n + textBytesAt(outcome.content.result, path, true),
              0,
            ),
          item.expectedOutputBytes,
          'Native stored output bytes changed',
        );
      } else if (item.kind === 'note') {
        const text =
          item.subtype === 'compaction'
            ? stored.content.data.summary
            : stored.content.text.slice(`[Synthetic ${item.subtype}]\n`.length);
        assert.equal(Buffer.byteLength(text), item.expectedTextBytes);
      } else {
        assert.equal(Buffer.byteLength(stored.content.text), item.expectedTextBytes);
        assert.equal(stored.content.attachments?.length ?? 0, item.attachments ?? 0);
      }
      statistics.verifiedSourceItems++;
    }
  }
  statistics.verifiedFidelity = true;
  statistics.limitations = [...limitations];
  return statistics;
}

function textBytesAt(value, path, json = false) {
  const segments = path.replace(/\[(\d+|\*)\]/g, '.$1').split('.');
  const visit = (node, index) => {
    if (index === segments.length) {
      if (json) return Buffer.byteLength(JSON.stringify(node));
      assert.equal(typeof node, 'string');
      return Buffer.byteLength(node);
    }
    const key = segments[index];
    return key === '*'
      ? node.reduce((n, item) => n + visit(item, index + 1), 0)
      : visit(node[key], index + 1);
  };
  return visit(value, 0);
}

function lineageIdentity(child) {
  const prefix =
    child.parentTurnIndex === undefined
      ? child.parentId + '_lineage_' + child.id
      : child.parentId + '_t' + child.parentTurnIndex;
  return {
    parentRunId: prefix + '_run',
    parentTurnId: prefix + '_turn',
    toolCallId:
      child.parentTurnIndex === undefined
        ? prefix + '_call'
        : prefix + '_item' + child.parentItemIndex + '_call',
  };
}

async function seedConnection(lease) {
  const policy = await openInteractiveRuntimePolicyStoresForWrite(lease);
  const catalog = await policy.connectionCatalog.getSnapshot();
  const created = await policy.connectionCatalog.create({
    expectedCatalogRevision: catalog.revision,
    connection: {
      slug: connectionSlug,
      name: 'Synthetic startup fixture',
      providerType: 'anthropic',
      enabled: true,
      enabledModelIds: [modelId],
    },
  });
  assert.equal(created.kind, 'committed');
  const connection = created.snapshot.connections.find(({ slug }) => slug === connectionSlug);
  assert(connection);
  assert.equal(
    (
      await policy.credentialVault.set({
        locator: { scope: 'connection', connectionId: connection.connectionId, kind: 'api_key' },
        expected: null,
        secret: 'synthetic-startup-placeholder',
      })
    ).kind,
    'committed',
  );
  const fetch = await policy.operations.beginModelFetch(connection.connectionId);
  assert.equal(fetch.kind, 'ready');
  const inventory = await policy.operations.completeModelFetch(fetch.ticket, {
    models: [{ id: modelId }],
    source: 'fallback',
    fetchedAt: Date.now(),
  });
  assert.equal(inventory.kind, 'committed');
  assert.equal(
    (
      await policy.connectionCatalog.setDefaultTarget({
        expectedCatalogRevision: inventory.snapshot.revision,
        target: { connectionId: connection.connectionId, modelId },
      })
    ).kind,
    'committed',
  );
  return connection.connectionId;
}
