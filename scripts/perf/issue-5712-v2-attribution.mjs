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
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Session } from 'node:inspector/promises';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { ClientSessionSubscription } from '../../packages/runtime-host/dist/client/session-subscription.js';
import { createSessionTranscriptReader } from '../../packages/runtime-host/dist/server/session-transcript-reader.js';
import {
  createSessionTranscriptBootstrap,
  readSessionTranscriptPage,
} from '../../packages/runtime-host/dist/server/session-transcript-pager.js';
import {
  SESSION_CONTINUITY_SCHEMA_VERSION,
  SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
} from '@maka/runtime-host/protocol';
import { RuntimeHostSessionObserver } from '../../apps/desktop/dist/main/runtime-host-session-observer.js';
import { runtimeHostSessionFixture } from '../../apps/desktop/dist/main/__tests__/runtime-host-session-test-fixture.js';

const manifest = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
assert.ok(manifest.workspaceRoot.includes('/artifacts/issue-5712-v2/'));
const output = resolve(process.argv[3]);
await mkdir(output, { recursive: true });
const capability = await resolveStorageRoot({ path: manifest.workspaceRoot, kind: 'interactive' });
const owner = await tryAcquireInteractiveRootOwner(capability);
assert.ok(owner, 'the isolated fixture must not be in use');
const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
const stringify = JSON.stringify;
const report = [];
try {
  for (const suffix of ['0002', '0003', '0006']) {
    const sessionId = manifest.sessionMap.find((entry) =>
      entry.lastRenderableTurnId.startsWith(`synthetic-session-${suffix}_`),
    ).sessionId;
    for (const mode of ['count', 'profile', 'cancel']) {
      const metrics = {
        suffix,
        mode,
        hostPages: 0,
        projectionPasses: 0,
        events: 0,
        sourceBytes: 0,
        serializedMessageCalls: 0,
        serializedMessageBytes: 0,
        wireBytes: 0,
        deliveredBytes: 0,
      };
      const invocations = new Set();
      const events = new Set();
      const countedStore = new Proxy(
        { ...stores.runtimeEventStore },
        {
          get(target, key) {
            if (key !== 'readTranscriptRun')
              return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
            return (id, request, consume) =>
              target.readTranscriptRun(id, request, (turn, source) => {
                metrics.projectionPasses += 1;
                invocations.add(turn.invocation.invocationId);
                function* counted() {
                  for (const entry of source) {
                    metrics.events += 1;
                    events.add(entry.event.id);
                    metrics.sourceBytes += Buffer.byteLength(stringify(entry.event));
                    yield entry;
                  }
                }
                return consume(turn, counted());
              });
          },
        },
      );
      const reader = createSessionTranscriptReader({
        stores: mode === 'profile' ? stores : { ...stores, runtimeEventStore: countedStore },
        canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
      });
      let observer;
      let cancelled;
      observer = new RuntimeHostSessionObserver({
        client: {
          async openSession() {
            const subscriptionId = `subscription-${sessionId}`;
            const opened = await createSessionTranscriptBootstrap({
              reader,
              sessionId,
              subscriptionId,
              throughSequence: await reader.readDurableHighWater(sessionId),
              maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
              projection: 'owner',
            });
            metrics.wireBytes += opened.bootstrap.durable.rawBytes;
            const subscription = new ClientSessionSubscription(
              {
                hostEpoch: 'host-1',
                subscriptionId,
                nextSequence: 1,
                activeAssistantStreams: [],
                transcript: opened.bootstrap,
                snapshot: {
                  schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
                  session: {
                    sessionId,
                    metadataRevision: 1,
                    status: 'active',
                    createdAt: 1,
                    isArchived: false,
                  },
                  projectionRevision: 1,
                  rootTurn: null,
                  goal: null,
                  queue: { hostEpoch: 'host-1', queueRevision: 0, steering: [], followup: [] },
                  interactions: { pending: [] },
                },
              },
              async () => {},
              async (request) => {
                metrics.hostPages += 1;
                const page = await readSessionTranscriptPage({
                  reader,
                  state: opened.state,
                  request,
                });
                metrics.wireBytes += page.rawBytes;
                return page;
              },
              async () => {},
            );
            return runtimeHostSessionFixture({
              snapshot: subscription.snapshot,
              events: subscription,
              transcriptBootstrap: opened.bootstrap,
              transcriptWatermark: () => subscription.transcriptWatermark,
              decodeTranscriptPage: (page, max, account) =>
                subscription.decodeTranscriptPage(page, (value) => value, max, account),
              loadTranscriptPage: (request) => subscription.loadTranscriptPage(request),
              close: () => subscription.close(),
            });
          },
        },
        emitSessionsChanged() {},
      });
      const profiler = new Session();
      if (mode === 'profile') {
        profiler.connect();
        await profiler.post('Profiler.enable');
        await profiler.post('Profiler.start');
      } else {
        JSON.stringify = function (value, ...args) {
          const result = stringify(value, ...args);
          if (
            value &&
            typeof value.type === 'string' &&
            typeof value.turnId === 'string' &&
            typeof value.ts === 'number'
          ) {
            metrics.serializedMessageCalls += 1;
            metrics.serializedMessageBytes += Buffer.byteLength(result);
          }
          return result;
        };
      }
      const start = performance.now();
      try {
        await observer.openTranscript(
          sessionId,
          'diagnostic',
          {
            id: 9,
            once() {},
            off() {},
            send(_channel, batch) {
              metrics.deliveredBytes += batch.fragments.reduce(
                (sum, fragment) => sum + fragment.data.byteLength,
                0,
              );
              if (mode === 'cancel' && !cancelled) {
                cancelled = {
                  atMs: performance.now() - start,
                  passes: metrics.projectionPasses,
                  events: metrics.events,
                };
                void observer.closeTranscript('diagnostic');
              } else
                observer.acknowledgeTranscript(
                  'diagnostic',
                  batch.generation,
                  batch.deliverySequence,
                  9,
                );
            },
          },
          'history',
        );
      } catch (error) {
        if (mode !== 'cancel') throw error;
        metrics.cancelOutcome = String(error);
      } finally {
        metrics.elapsedMs = performance.now() - start;
        JSON.stringify = stringify;
        if (mode === 'profile') {
          const { profile } = await profiler.post('Profiler.stop');
          await writeFile(join(output, `${suffix}.cpuprofile`), stringify(profile));
          profiler.disconnect();
        }
        await observer.close();
      }
      report.push({
        ...metrics,
        uniqueInvocations: invocations.size,
        uniqueEvents: events.size,
        cancelled,
        residualProjectionPasses: cancelled ? metrics.projectionPasses - cancelled.passes : null,
        residualEvents: cancelled ? metrics.events - cancelled.events : null,
      });
      await writeFile(join(output, 'attribution.json'), stringify(report, null, 2));
      console.log(stringify(report.at(-1)));
    }
  }
} finally {
  JSON.stringify = stringify;
  await stores.sessionStore.close();
  await owner.close();
}
