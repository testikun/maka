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

// Measurement only: inserted into the generated preload immediately before
// exposeInMainWorld. The runner restores that generated file after the run.
globalThis.__issue5627Preload = { enabled: true, entries: [] };
{
  const original = makaBridge.transcripts.open.bind(makaBridge.transcripts);
  makaBridge.transcripts.open = async (sessionId, handler, ...args) => {
    const probe = globalThis.__issue5627Preload;
    const at = () => performance.timeOrigin + performance.now();
    const trace = { sessionId, openedAt: at(), batches: [] };
    if (probe.enabled) probe.entries.push(trace);
    const result = await original(
      sessionId,
      (batch) => {
        if (!probe.enabled) return handler(batch);
        const item = {
          at: at(),
          ready: batch.ready,
          generation: batch.generation,
          hostEpoch: batch.hostEpoch,
          deliverySequence: batch.deliverySequence,
          bytes: batch.fragments.reduce((n, f) => n + f.data.byteLength, 0),
        };
        trace.batches.push(item);
        handler(batch);
        item.handledAt = at();
      },
      ...args,
    );
    trace.resolvedAt = at();
    return result;
  };
  import_electron4.contextBridge.exposeInMainWorld('maka5627Probe', {
    reset(enabled = true) {
      globalThis.__issue5627Preload.entries = [];
      globalThis.__issue5627Preload.enabled = enabled;
    },
    read() {
      return globalThis.__issue5627Preload.entries;
    },
  });
}
