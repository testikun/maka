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

import type { FollowUpMode, InlineReference } from '@maka/core/events';
import type { DesktopTranscriptRangeController } from './desktop-transcript-range-store.js';

export interface WorkspaceFileReferencePosition {
  value: string;
  start: number;
}

export function resolveFollowUpModeAtSubmit(input: {
  requestedMode?: FollowUpMode;
}): FollowUpMode {
  // Existing-session text always enters through the Host's atomic message
  // admission. An idle Host starts a turn; an active Host queues it. Shift+Enter
  // is the only renderer-owned choice because the user explicitly requested
  // the current-turn steering lane.
  return input.requestedMode ?? 'queue';
}

export async function returnToLatestBeforeSubmit(input: {
  sessionId: string;
  activeIdRef: { current: string | undefined };
  transcriptRangeRef: { current: DesktopTranscriptRangeController | undefined };
}): Promise<boolean> {
  const controller = input.transcriptRangeRef.current;
  if (!controller) return true;
  let hasNewer = false;
  try {
    const range = controller.store.range();
    hasNewer = range.sessionId === input.sessionId && range.hasNewer;
  } catch {
    // An unopened transcript is not a sparse historical view.
  }
  if (!hasNewer) return true;
  await controller.loadLatest();
  return input.activeIdRef.current === input.sessionId
    && input.transcriptRangeRef.current === controller;
}

export function mergeWorkspaceReferences(
  text: string,
  live: readonly WorkspaceFileReferencePosition[] | undefined,
  restored: readonly InlineReference[] | undefined,
): WorkspaceFileReferencePosition[] {
  const merged = new Map<string, WorkspaceFileReferencePosition>();
  for (const reference of live ?? []) {
    merged.set(`${reference.start}:${reference.value}`, { ...reference });
  }
  let cursor = 0;
  for (const reference of restored ?? []) {
    if (reference.kind !== 'workspace_file') continue;
    let start = reference.start;
    if (text.slice(start, start + reference.value.length) !== reference.value) {
      start = text.indexOf(reference.value, cursor);
    }
    if (start < 0) continue;
    cursor = start + reference.value.length;
    merged.set(`${start}:${reference.value}`, { value: reference.value, start });
  }
  return [...merged.values()].sort((left, right) => left.start - right.start);
}
