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

import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import type { SessionEvent } from '@maka/core/events';
import type { SessionSummary, TurnRecord } from '@maka/core/session';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  createFakeWorkbarServices,
  useQuoteCompanion,
  WorkbarServicesProvider,
  type UseQuoteCompanionResult,
  type WorkbarServices,
} from '../../renderer/features/workbar/testing.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function session(id: string): SessionSummary {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'test',
    connectionLocked: false,
    model: 'test-model',
    permissionMode: 'ask',
  };
}

const source = session('source');
const fork = session('fork');
let current: UseQuoteCompanionResult | undefined;

function Probe() {
  current = useQuoteCompanion({
    panelId: 'panel',
    pendingQuotes: [],
    sourceSession: source,
    locale: 'en',
    onQuotesConsumed: () => undefined,
  });
  return null;
}

function companion(): UseQuoteCompanionResult {
  assert.ok(current);
  return current;
}

afterEach(() => {
  current = undefined;
  cleanupFakeDom();
});

test('a late terminal event cannot claim a pending steered companion message', async () => {
  const { root } = installReactRenderer();
  const pendingSend = deferred<{ ok: true; turnId: string; steered: true }>();
  let eventHandler: ((event: SessionEvent) => void) | undefined;
  let submittedMessageId: string | undefined;
  const defaults = createFakeWorkbarServices();
  const services = createFakeWorkbarServices({
    sideChat: {
      ...defaults.sideChat,
      listTurns: async (): Promise<TurnRecord[]> => [
        { turnId: 'source-turn', status: 'completed', partialOutputRetained: false },
      ],
      branchFromTurn: async () => fork,
      subscribeEvents: (_sessionId, handler) => {
        eventHandler = handler;
        return () => undefined;
      },
      send: async (_sessionId, command) => {
        submittedMessageId = command.turnId;
        return pendingSend.promise;
      },
    },
  });

  await act(async () => {
    root.render(
      createElement(
        WorkbarServicesProvider,
        { services },
        createElement(Probe),
      ),
    );
  });
  assert.equal(companion().companionSession?.id, fork.id);

  let sendResult: Promise<boolean> | undefined;
  await act(async () => {
    sendResult = companion().send('follow up');
    await Promise.resolve();
  });
  assert.ok(eventHandler);
  assert.ok(submittedMessageId);
  const messageId = submittedMessageId;
  assert.equal(companion().processing, true);

  await act(async () => {
    eventHandler?.({
      type: 'complete',
      id: 'late-complete',
      turnId: 'previous-turn',
      ts: 1,
      stopReason: 'end_turn',
    });
    await Promise.resolve();
  });
  assert.equal(companion().processing, true);

  await act(async () => {
    pendingSend.resolve({ ok: true, steered: true, turnId: messageId });
    assert.equal(await sendResult, true);
  });
  await act(async () => {
    eventHandler?.({
      type: 'queue_update',
      id: 'steering-queue',
      turnId: 'successor-turn',
      ts: 2,
      queueRevision: 1,
      steering: ['follow up'],
      followup: [],
      steeringEntries: [
        {
          entryId: 'steering-entry',
          messageId,
          content: { text: 'follow up' },
          placement: 'current_turn',
          state: 'queued',
        },
      ],
      followupEntries: [],
    });
    eventHandler?.({
      type: 'text_delta',
      id: 'successor-text',
      messageId: 'assistant-message',
      turnId: 'successor-turn',
      ts: 3,
      text: 'answer',
    });
  });

  assert.equal(companion().liveTurn?.turnId, 'successor-turn');
  assert.equal(companion().streaming, true);
});

test('replays a new Host turn that starts before its send result arrives', async () => {
  const { root } = installReactRenderer();
  const pendingSend = deferred<{ ok: true; turnId: string }>();
  let eventHandler: ((event: SessionEvent) => void) | undefined;
  const defaults = createFakeWorkbarServices();
  const services: WorkbarServices = createFakeWorkbarServices({
    sideChat: {
      ...defaults.sideChat,
      listTurns: async (): Promise<TurnRecord[]> => [
        { turnId: 'source-turn', status: 'completed', partialOutputRetained: false },
      ],
      branchFromTurn: async () => fork,
      subscribeEvents: (_sessionId, handler) => {
        eventHandler = handler;
        return () => undefined;
      },
      send: () => pendingSend.promise,
    },
  });

  await act(async () => {
    root.render(
      createElement(
        WorkbarServicesProvider,
        { services },
        createElement(Probe),
      ),
    );
  });
  assert.equal(companion().companionSession?.id, fork.id);

  let sendResult: Promise<boolean> | undefined;
  await act(async () => {
    sendResult = companion().send('first question');
    await Promise.resolve();
  });
  assert.ok(eventHandler);

  await act(async () => {
    eventHandler?.({
      type: 'text_delta',
      id: 'early-text',
      messageId: 'assistant-message',
      turnId: 'host-root-turn',
      ts: 1,
      text: 'early answer',
    });
    eventHandler?.({
      type: 'complete',
      id: 'early-complete',
      turnId: 'host-root-turn',
      ts: 2,
      stopReason: 'end_turn',
    });
  });
  assert.equal(companion().liveTurn, undefined);
  assert.equal(companion().processing, true);

  await act(async () => {
    pendingSend.resolve({ ok: true, turnId: 'host-root-turn' });
    assert.equal(await sendResult, true);
    await Promise.resolve();
  });

  assert.equal(companion().liveTurn?.turnId, 'host-root-turn');
  assert.equal(companion().liveTurn?.steps[0]?.text?.text, 'early answer');
  assert.equal(companion().streaming, false);
  assert.equal(companion().processing, false);
});
