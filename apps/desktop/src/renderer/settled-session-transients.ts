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

import type { SessionSummary } from '@maka/core/session';
import type { LiveTurnProjection } from '@maka/ui';

/**
 * Which sessions' turn transients are safe to drop, i.e. whose turn the
 * authority says is over.
 *
 * Host-owned running turn identities outrank the coarser persisted status. The
 * renderer no longer creates an optimistic live turn before Host admission, so
 * there is no client-owned pending claim to reconcile here.
 */
export function settledSessionTransientIds(options: {
  activeId?: string;
  sessions: readonly SessionSummary[];
  liveTurnBySession: Readonly<Record<string, LiveTurnProjection>>;
}): string[] {
  return options.sessions.flatMap((session) => {
    // The live runs first: a persisted status can disagree with them in both
    // directions — it is written after the run starts and can be left behind
    // entirely by a crash — so anything the runtime still reports as running
    // keeps its transients regardless of what the header says.
    if (session.runningTurnIds?.length) return [];
    if (session.status === 'waiting_for_user') return [];
    if (session.runningTurnIds === undefined && session.status === 'running') return [];
    const projection = options.liveTurnBySession[session.id];
    if (session.id === options.activeId && projection?.terminal) return [];
    return [session.id];
  });
}

/**
 * Reconcile one accepted authority read against the exact live projections
 * observed before that read began. The conditional clear is a compare-and-swap:
 * a Turn confirmed, replaced, or otherwise advanced while the read was in
 * flight cannot be retired by that older catalog snapshot.
 */
export function reconcileSettledSessionTransients(options: {
  activeId?: string;
  sessions: readonly SessionSummary[];
  observedLiveTurnBySession: Readonly<Record<string, LiveTurnProjection>>;
  clearTurnTransientStateIfCurrent: (
    sessionId: string,
    expected: LiveTurnProjection | undefined,
  ) => void;
}): void {
  const sessionIds = settledSessionTransientIds({
    activeId: options.activeId,
    sessions: options.sessions,
    liveTurnBySession: options.observedLiveTurnBySession,
  });
  for (const sessionId of sessionIds) {
    options.clearTurnTransientStateIfCurrent(
      sessionId,
      options.observedLiveTurnBySession[sessionId],
    );
  }
}
