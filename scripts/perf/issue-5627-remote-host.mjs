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

// Disposable benchmark Host. No installed service, real provider, or user profile.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { createInterface } from 'node:readline';
import { WebSocket, WebSocketServer } from 'ws';
import { FakeBackend } from '@maka/runtime/test-only/fake-backend';
import { resolveStorageRoot } from '@maka/storage/root-authority';
import { startExecutionRuntimeHostService } from '../../packages/runtime-host/dist/server/execution-service.js';
import { createExecutionRuntimeHostComposition } from '../../packages/runtime-host/dist/server/execution-composition.js';
import {
  connectRuntimeHost,
  consumeAccessCredentialDelivery,
  REMOTE_DESKTOP_OWNER_ACCESS_POLICY,
} from '@maka/runtime-host/client';
import { createClientRuntimeHostProfileCatalog } from '../../packages/runtime-host/dist/client/host-profile.js';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '@maka/runtime-host/protocol';

const [manifestPath, clientData, transport = 'remote'] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const now = () => performance.timeOrigin + performance.now();
const reply = (message) =>
  process.send
    ? process.send(message)
    : process.stdout.write(`BENCH5627:${JSON.stringify(message)}\n`);
const streams = {};
const wire = [];
let delayMs = 0;
let tracing = true;
class ObservedBackend extends FakeBackend {
  constructor(context) {
    super(context);
    this.sessionId = context.sessionId;
  }
  async *send(input) {
    const state = (streams[this.sessionId] = {
      turnId: input.turnId,
      deltas: 0,
      bytes: 0,
      startedAt: now(),
      endedAt: null,
    });
    try {
      const backendInput =
        input.text === '__issue_5627_stream__'
          ? { ...input, text: '__issue_5627_stream__' + 'stream line\n'.repeat(10000) }
          : input;
      for await (const event of super.send(backendInput)) {
        if (event.type === 'text_delta') {
          state.deltas += 1;
          state.bytes += Buffer.byteLength(event.text);
          state.lastDeltaAt = now();
        }
        yield event;
      }
    } finally {
      state.endedAt = now();
    }
  }
}
const host = await startExecutionRuntimeHostService(
  {
    rootPath: manifest.workspaceRoot,
    websocket: { host: '127.0.0.1', port: 0 },
  },
  {
    createComposition: (context, options) =>
      createExecutionRuntimeHostComposition(context, options, {
        primaryBackendFactory: (context) => new ObservedBackend(context),
      }),
  },
);
const capability = await resolveStorageRoot({ path: manifest.workspaceRoot, kind: 'interactive' });
const local = await connectRuntimeHost({
  rootPath: manifest.workspaceRoot,
  protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
});
if (local.kind !== 'connected') throw new Error(`Host connection: ${local.kind}`);
const issued = await local.connection.request('access.credential.issue', {
  ...REMOTE_DESKTOP_OWNER_ACCESS_POLICY,
  principalId: 'issue-5627-isolated-benchmark',
});
const credential = await consumeAccessCredentialDelivery(
  manifest.workspaceRoot,
  issued.deliveryId,
  issued.credentialId,
);

// Delay complete protocol frames in both directions. FIFO queues preserve ordering
// even when a later test reduces the delay while older frames are in flight;
// a 10 ms one-way delay approximates 20 ms added RTT, not bandwidth or WSL.
const proxyPort = Number(process.env.BENCH5627_PROXY_PORT ?? 0);
const proxy = new WebSocketServer({
  host: proxyPort ? '0.0.0.0' : '127.0.0.1',
  port: proxyPort,
  perMessageDeflate: false,
});
await new Promise((resolve) => proxy.once('listening', resolve));
let connectionId = 0;
proxy.on('connection', (client, request) => {
  const id = ++connectionId;
  const upstream = new WebSocket(host.websocketEndpoints[0], {
    perMessageDeflate: false,
    headers: request.headers.authorization ? { authorization: request.headers.authorization } : {},
  });
  const queued = [];
  const lanes = { 'to-host': { items: [], timer: null }, 'to-desktop': { items: [], timer: null } };
  const drain = (lane) => {
    lane.timer = null;
    while (lane.items.length && lane.items[0].due <= now()) lane.items.shift().send();
    if (lane.items.length)
      lane.timer = setTimeout(() => drain(lane), Math.max(1, lane.items[0].due - now()));
  };
  const forward = (data, binary, target, direction) => {
    const receivedAt = now();
    let record;
    if (tracing) {
      try {
        const frame = JSON.parse(data.toString());
        // Record identities and sizes only; never persist authentication/payload.
        record = {
          at: receivedAt,
          connectionId: id,
          direction,
          bytes: data.length,
          kind: frame.kind,
          operation: frame.operation,
          requestId: frame.requestId,
          subscriptionId:
            frame.subscriptionId ?? frame.input?.subscriptionId ?? frame.result?.subscriptionId,
          sessionId: frame.input?.sessionId ?? frame.result?.sessionId,
          ok: frame.ok,
          sequence: frame.sequence,
        };
        wire.push(record);
      } catch {
        /* authentication frames need no content capture */
      }
    }
    const send = () => {
      if (target.readyState === WebSocket.OPEN) {
        if (record) record.forwardedAt = now();
        target.send(data, { binary });
      }
    };
    const lane = lanes[direction];
    lane.items.push({ due: receivedAt + delayMs, send });
    if (!lane.timer) drain(lane);
  };
  client.on('message', (data, binary) => {
    if (upstream.readyState === WebSocket.OPEN) forward(data, binary, upstream, 'to-host');
    else queued.push([data, binary]);
  });
  upstream.on('open', () => {
    for (const [data, binary] of queued) forward(data, binary, upstream, 'to-host');
    queued.length = 0;
  });
  upstream.on('message', (data, binary) => forward(data, binary, client, 'to-desktop'));
  client.on('close', () => upstream.close());
  upstream.on('close', () => client.close());
  client.on('error', () => upstream.close());
  upstream.on('error', () => client.close());
});
await mkdir(clientData, { recursive: true });
if (transport === 'remote') {
  // Desktop's local board metadata store must exist even with a remote default.
  if (process.platform === 'darwin') {
    const bootstrap = await startExecutionRuntimeHostService({
      rootPath: join(clientData, 'workspaces/default'),
    });
    await bootstrap.close();
  }
  await createClientRuntimeHostProfileCatalog(clientData).save(
    {
      id: 'repro-remote',
      name: 'Issue 5627 remote protocol',
      kind: 'remote',
      rootId: capability.rootId,
      transport: {
        kind: 'plaintext',
        url: `ws://127.0.0.1:${proxy.address().port}/runtime-host`,
        acknowledgement: 'plaintext-bearer-v1',
      },
    },
    credential,
  );
  await writeFile(
    join(clientData, 'runtime-host-profile-selection.json'),
    JSON.stringify({
      schemaVersion: 2,
      defaultProfileId: 'repro-remote',
      enabledRemoteProfileIds: ['repro-remote'],
    }),
  );
}
const receive = async (message) => {
  if (message.type === 'snapshot') {
    reply({
      id: message.id,
      streams,
      wire: wire.splice(0),
      hostEpoch: host.hostEpoch,
      hostNow: now(),
      cpu: process.cpuUsage(),
      memory: process.memoryUsage(),
    });
  } else if (message.type === 'configure') {
    delayMs = message.delayMs;
    tracing = message.tracing !== false;
    reply({ id: message.id, delayMs, tracing });
  } else if (message.type === 'close') {
    for (const client of proxy.clients) client.terminate();
    proxy.close();
    local.connection.close();
    await host.close();
    process.exit(0);
  }
};
process.on('message', receive);
if (!process.send)
  createInterface({ input: process.stdin }).on('line', (line) => void receive(JSON.parse(line)));
reply({
  type: 'ready',
  hostEpoch: host.hostEpoch,
  rootId: capability.rootId,
  pid: process.pid,
  platform: process.platform,
  os: os.release(),
  arch: process.arch,
  node: process.version,
});
