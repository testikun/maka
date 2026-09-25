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
import { fork, spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { _electron } from '@playwright/test';
import electronPath from 'electron';
import { buildFixtureEnv } from '../fixture-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({
  allowNegative: true,
  options: {
    manifest: { type: 'string' },
    output: { type: 'string' },
    runs: { type: 'string', default: '3' },
    transport: { type: 'string', default: 'remote' },
    'dev-url': { type: 'string' },
    executable: { type: 'string' },
    delays: { type: 'string', default: '0,10' },
    probe: { type: 'boolean', default: true },
    order: { type: 'string', default: 'idle,active' },
    'linux-host': { type: 'boolean', default: false },
    'probe-ablation': { type: 'boolean', default: false },
    'settle-window-ms': { type: 'string', default: '1500' },
    label: { type: 'string' },
    'reading-checks': { type: 'boolean', default: false },
    'pace-from': { type: 'string' },
  },
});
assert(values.manifest && values.output);
const manifestPath = resolve(values.manifest);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const pacing = values['pace-from'] ? JSON.parse(await readFile(values['pace-from'], 'utf8')) : null;
assert(manifest.userDataDir.startsWith(join(ROOT, 'artifacts/')));
const output = resolve(values.output);
const clientData =
  values.transport === 'local' ? manifest.userDataDir : join(output, 'desktop-user-data');
await mkdir(output, { recursive: true });
const report = {
  startedAt: new Date().toISOString(),
  label: values.label ?? null,
  paceFrom: values['pace-from'] ?? null,
  environment: {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    os: os.release(),
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0].model,
    node: process.version,
    transport: values.transport,
    devUrl: values['dev-url'] ?? null,
    executable: values.executable ?? electronPath,
    probe: values.probe,
  },
  fixture: { totals: manifest.totals, sessions: manifest.sessionMap },
  samples: [],
};
const target = manifest.sessionMap[0];
const source = manifest.sessionMap[1];
const preloadPath = join(ROOT, 'apps/desktop/dist/preload/preload.cjs');
let oldPreload;
let app;
let page;
let host;
let sendHost;
let containerName;
let nextId = 0;
const pending = new Map();
const hostLog = [];
const desktopLog = [];
const now = () => performance.timeOrigin + performance.now();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (message) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Host ${message.type} timed out`));
    }, 10000);
    pending.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    sendHost({ ...message, id });
  });
try {
  const hostArgs = [
    join(ROOT, 'scripts/perf/issue-5627-remote-host.mjs'),
    manifestPath,
    clientData,
    values.transport,
  ];
  if (values['linux-host']) {
    assert.equal(values.transport, 'remote');
    const { startExecutionRuntimeHostService } = await import(
      '../../packages/runtime-host/dist/server/execution-service.js'
    );
    const bootstrap = await startExecutionRuntimeHostService({
      rootPath: join(clientData, 'workspaces/default'),
    });
    await bootstrap.close();
    const socket = createServer();
    await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    containerName = `maka-5627-${process.pid}`;
    host = spawn(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--name',
        containerName,
        '-p',
        `127.0.0.1:${port}:${port}`,
        '-v',
        `${ROOT}:${ROOT}`,
        '-w',
        ROOT,
        '-e',
        `BENCH5627_PROXY_PORT=${port}`,
        '-e',
        `GIT_CEILING_DIRECTORIES=${ROOT}/artifacts`,
        'maka-5627-host:local',
        'node',
        ...hostArgs,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    createInterface({ input: host.stdout }).on('line', (line) => {
      if (line.startsWith('BENCH5627:')) host.emit('message', JSON.parse(line.slice(10)));
      else hostLog.push(line + '\n');
    });
    sendHost = (message) => host.stdin.write(`${JSON.stringify(message)}\n`);
  } else {
    host = fork(hostArgs[0], hostArgs.slice(1), {
      cwd: ROOT,
      env: buildFixtureEnv(manifest.userDataDir, manifest.homeDir),
      silent: true,
    });
    host.stdout.on('data', (data) => hostLog.push(data.toString()));
    sendHost = (message) => host.send(message);
  }
  host.stderr.on('data', (data) => hostLog.push(data.toString()));
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Host startup timeout: ${hostLog.join('').slice(-3000)}`)),
      60000,
    );
    host.on('message', (message) => {
      if (message.type === 'ready') {
        clearTimeout(timer);
        report.host = message;
        resolveReady();
      } else {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    });
    host.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Host exited ${code}: ${hostLog.join('').slice(-3000)}`));
    });
  });
  const clockSamples = [];
  for (let i = 0; i < 5; i++) {
    const sentAt = now();
    const snapshot = await ask({ type: 'snapshot' });
    const receivedAt = now();
    clockSamples.push({
      roundTripMs: receivedAt - sentAt,
      hostMinusClientMs: snapshot.hostNow - (sentAt + receivedAt) / 2,
    });
  }
  report.hostClock = clockSamples.sort((a, b) => a.roundTripMs - b.roundTripMs)[0];
  if (!values.executable) {
    oldPreload = await readFile(preloadPath, 'utf8');
    const marker = 'import_electron4.contextBridge.exposeInMainWorld("maka", makaBridge);';
    assert.equal(oldPreload.split(marker).length, 2, 'Generated preload insertion point changed');
    const probe = await readFile(join(ROOT, 'scripts/perf/issue-5627-preload-probe.cjs'), 'utf8');
    await writeFile(preloadPath, oldPreload.replace(marker, `${probe}\n${marker}`));
  }
  const env = buildFixtureEnv(clientData, manifest.homeDir, { locale: 'zh-CN', showWindow: true });
  delete env.ELECTRON_RUN_AS_NODE;
  if (values['dev-url']) env.VITE_DEV_SERVER_URL = values['dev-url'];
  if (values.executable) {
    env.MAKA_UPDATE_TEST_USER_DATA_DIR = clientData;
    env.MAKA_UPDATE_TEST_FEED = 'http://127.0.0.1:1/issue-5627-update-disabled';
  }
  app = await _electron.launch({
    executablePath: values.executable ? resolve(values.executable) : electronPath,
    args: values.executable ? [] : ['.'],
    cwd: join(ROOT, 'apps/desktop'),
    env,
    timeout: 60000,
  });
  app.process().stdout?.on('data', (data) => desktopLog.push(data.toString()));
  app.process().stderr?.on('data', (data) => desktopLog.push(data.toString()));
  report.runtime = await app.evaluate(({ app }) => ({
    isPackaged: app.isPackaged,
    userData: app.getPath('userData'),
    versions: process.versions,
  }));
  assert.equal(report.runtime.userData, clientData);
  page = await app.firstWindow();
  page.setDefaultTimeout(60000);
  await page.locator('.maka-composer-editor [contenteditable="true"]').first().waitFor();
  const expandSidebar = page.getByRole('button', { name: /^(展开侧边栏|Expand sidebar)$/ });
  if (await expandSidebar.isVisible()) await expandSidebar.click();
  await page.locator('[data-session-id]').first().waitFor();
  // Prepare all IPC probes once, outside the timed window.
  await app.evaluate(({ ipcMain, webContents }) => {
    const state = (globalThis.__matched5627 = { events: [], enabled: true });
    const at = () => performance.timeOrigin + performance.now();
    for (const [channel, original] of ipcMain._invokeHandlers) {
      if (!channel.startsWith('sessions:transcript:')) continue;
      ipcMain._invokeHandlers.set(channel, async (...args) => {
        if (!state.enabled) return original(...args);
        const e = { channel, at: at() };
        state.events.push(e);
        try {
          return await original(...args);
        } finally {
          e.resolvedAt = at();
        }
      });
    }
    for (const contents of webContents.getAllWebContents()) {
      const original = contents.send;
      contents.send = function (channel, ...args) {
        if (state.enabled && channel.startsWith('sessions:transcript:')) {
          const b = args.find((arg) => arg?.fragments);
          if (b)
            state.events.push({
              channel,
              at: at(),
              generation: b.generation,
              deliverySequence: b.deliverySequence,
              ready: b.ready,
              bytes: b.fragments.reduce((n, f) => n + f.data.byteLength, 0),
            });
        }
        return original.call(this, channel, ...args);
      };
    }
  });
  const resolveId = async (entry) => {
    const row = page.locator('[data-session-id]').filter({ hasText: entry.name }).first();
    await row.waitFor();
    return row.evaluate((node) => node.getAttribute('data-session-id'));
  };
  const targetId = await resolveId(target);
  const sourceId = await resolveId(source);
  report.targetId = targetId;
  report.sourceId = sourceId;
  if (values.transport === 'remote') assert.equal(JSON.parse(targetId)[0], report.host.rootId);
  const rowFor = (id) => page.locator(`[data-session-id=${JSON.stringify(id)}]`);
  const select = async (id, entry) => {
    const row = rowFor(id);
    await row.scrollIntoViewIfNeeded();
    if (!(await row.locator('[aria-current="page"]').count())) await row.click();
    await page
      .locator(`[data-turn-id^=${JSON.stringify(entry.lastRenderableTurnId)}]`)
      .first()
      .waitFor();
    await delay(600);
  };
  await select(targetId, target);
  report.warmupWire = (await ask({ type: 'snapshot' })).wire;
  await select(sourceId, source);
  await select(targetId, target);
  if (values['reading-checks']) {
    const count = () =>
      page.locator('[data-turn-source-count]').getAttribute('data-turn-source-count');
    const initialTurns = Number(await count());
    assert(initialTurns > 0 && initialTurns < target.turns, 'the real UI opens a bounded range');
    assert.equal(
      await page.getByRole('button', { name: '载入更早的记录', exact: true }).count(),
      0,
    );
    const scroller = page.locator('[data-chat-scroll-container]').first();
    const bounds = await scroller.boundingBox();
    assert(bounds);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    for (let step = 0; step < 40 && Number(await count()) === initialTurns; step++) {
      await page.mouse.wheel(0, -600);
      await delay(150);
    }
    await page.waitForFunction(
      (before) =>
        Number(
          document
            .querySelector('[data-turn-source-count]')
            ?.getAttribute('data-turn-source-count'),
        ) > before,
      initialTurns,
    );
    const expandedTurns = Number(await count());
    assert(expandedTurns < target.turns, 'one earlier request remains bounded');
    await page.screenshot({ path: join(output, 'automatic-earlier-history.png') });
    const readingTurn = () =>
      scroller.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const row = [...element.querySelectorAll('[data-turn-id]')].find((node) => {
          const box = node.getBoundingClientRect();
          return box.bottom > bounds.top + 40 && box.top < bounds.bottom;
        });
        return row?.getAttribute('data-turn-id');
      });
    let oldAnchor;
    for (let step = 0; step < 50; step++) {
      oldAnchor = await readingTurn();
      const index = Number(oldAnchor?.match(/_t(\d+)_turn/)?.[1]);
      if (Number.isFinite(index) && index < target.turns - initialTurns - 2) break;
      await page.mouse.wheel(0, -600);
      await delay(150);
    }
    assert(
      Number(oldAnchor?.match(/_t(\d+)_turn/)?.[1]) < target.turns - initialTurns - 2,
      'read outside the initial range',
    );
    await delay(600);
    await select(sourceId, source);
    const restoreStartedAt = now();
    await rowFor(targetId).click();
    await page.waitForFunction((id) => {
      const scroller = document.querySelector('[data-chat-scroll-container]');
      const row = document.querySelector(`[data-turn-id="${CSS.escape(id)}"]`);
      if (!scroller || !row) return false;
      const bounds = scroller.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      return box.bottom > bounds.top && box.top < bounds.bottom;
    }, oldAnchor);
    const oldAnchorRestoredMs = now() - restoreStartedAt;
    await page.screenshot({ path: join(output, 'restored-old-reading-position.png') });
    const returnedBounds = await scroller.boundingBox();
    await page.mouse.move(
      returnedBounds.x + returnedBounds.width / 2,
      returnedBounds.y + returnedBounds.height / 2,
    );
    await page.mouse.wheel(0, 100000);
    await delay(600);
    await select(sourceId, source);
    await select(targetId, target);
    report.readingChecks = {
      initialTurns,
      expandedTurns,
      oldAnchor,
      oldAnchorRestoredMs,
      returnedTurns: Number(await count()),
    };
    await writeFile(
      join(output, 'reading-checks.json'),
      JSON.stringify(report.readingChecks, null, 2),
    );
  }
  // Paired state blocks run in one process; the order is recorded, with a
  // reverse-order invocation available to check history accumulation bias.
  for (const state of values.order.split(',')) {
    if (state === 'active') {
      const submission = await page.evaluate(
        async (sessionId) =>
          window.maka.sessions.submitMessage(
            sessionId,
            'next_turn',
            { messageId: crypto.randomUUID(), text: '__issue_5627_stream__' },
            { waitForHostAdmission: true },
          ),
        targetId,
      );
      assert(submission.ok, JSON.stringify(submission));
      await page.waitForFunction(
        () => document.querySelector('.maka-bubble-streaming')?.textContent?.length > 0,
      );
    }
    for (let run = 1; run <= Number(values.runs); run++) {
      const delays = values.delays.split(',').map(Number);
      if (run % 2 === 0) delays.reverse();
      const probes = values['probe-ablation']
        ? run % 2
          ? [true, false]
          : [false, true]
        : [values.probe];
      for (const { oneWayMs, enabled } of delays.flatMap((oneWayMs) =>
        probes.map((enabled) => ({ oneWayMs, enabled })),
      )) {
        await ask({ type: 'configure', delayMs: oneWayMs, tracing: enabled });
        const beforeAway = await ask({ type: 'snapshot' });
        const beforeAwayMetrics = await app.evaluate(({ app }) => app.getAppMetrics());
        await select(sourceId, source);
        await delay(700);
        // Match the baseline's age of the continuously growing live Turn;
        // otherwise a faster loop also benchmarks a shorter assistant answer.
        if (pacing && state === 'active') {
          const reference = pacing.samples.find(
            (sample) =>
              sample.state === state && sample.run === run && sample.addedRttMs === 2 * oneWayMs,
          );
          assert(reference, 'missing baseline pacing sample');
          const referenceAge =
            reference.startAt +
            pacing.hostClock.hostMinusClientMs -
            reference.activeEvidence.beforeReturn.startedAt;
          const returnAt =
            beforeAway.streams[target.sessionId].startedAt -
            report.hostClock.hostMinusClientMs +
            referenceAge;
          await delay(Math.max(0, returnAt - now()));
        }
        const beforeReturn = await ask({ type: 'snapshot' });
        const beforeReturnMetrics = await app.evaluate(({ app }) => app.getAppMetrics());
        const beforeStream = beforeReturn.streams[target.sessionId];
        report.currentAttempt = {
          state,
          run,
          addedRttMs: oneWayMs * 2,
          beforeAway: beforeAway.streams[target.sessionId],
          beforeReturn: beforeStream,
        };
        assert.equal(Boolean(beforeStream && !beforeStream.endedAt), state === 'active');
        if (state === 'active') {
          assert(!beforeReturn.streams[target.sessionId].endedAt);
          assert(
            beforeReturn.streams[target.sessionId].deltas >
              beforeAway.streams[target.sessionId].deltas,
          );
        }
        await rowFor(targetId).scrollIntoViewIfNeeded();
        const box = await rowFor(targetId).boundingBox();
        assert(box);
        await app.evaluate((_, enabled) => {
          globalThis.__matched5627.events = [];
          globalThis.__matched5627.enabled = enabled;
        }, enabled);
        await page.evaluate(
          ({ targetId, targetTurn, sourceTurn, enabled, active }) => {
            window.maka5627Probe?.reset(enabled);
            const clock = () => performance.timeOrigin + performance.now();
            const targetSelector = `[data-session-id="${CSS.escape(targetId)}"] [aria-current="page"]`;
            const targetHistory = `[data-turn-id^="${CSS.escape(targetTurn.replace(/_t\d+_turn$/, ''))}_t"]`;
            const sourceSelector = `[data-turn-id^="${CSS.escape(sourceTurn)}"]`;
            const anchorSelector = `[data-turn-id^="${CSS.escape(targetTurn)}"]`;
            const p = (window.__matched5627 = {
              startAt: null,
              lastSignature: null,
              signatureSince: 0,
              signatureChanges: 0,
            });
            document.addEventListener(
              'pointerdown',
              () => {
                p.startAt = clock();
              },
              { once: true, capture: true },
            );
            p.timer = setInterval(() => {
              if (!p.startAt) return;
              const at = clock();
              const selected = Boolean(document.querySelector(targetSelector));
              if (selected) p.selectedAt ??= at;
              if (!document.querySelector(sourceSelector)) p.oldGoneAt ??= at;
              if (document.querySelector(targetHistory)) p.firstHistoryAt ??= at;
              const anchor = document.querySelector(anchorSelector);
              if (anchor) p.anchorAt ??= at;
              const live = document.querySelector('.maka-bubble-streaming');
              const liveLength = selected ? (live?.textContent?.length ?? 0) : 0;
              if (selected && liveLength) {
                p.liveAt ??= at;
                p.firstLiveLength ??= liveLength;
                if (liveLength > p.firstLiveLength) p.liveAdvancedAt ??= at;
              }
              if (selected && p.oldGoneAt && (p.firstHistoryAt || p.liveAt) && !p.paintScheduled) {
                p.paintScheduled = true;
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    p.firstContentPaintAt = clock();
                  }),
                );
              }
              // A long live answer legitimately pushes historical DOM rows out
              // of the virtual viewport. Require the loaded historical range,
              // not a simultaneously mounted old row, in addition to visible
              // live output that has advanced after the switch.
              const loadedHistoryCount = Number(
                document
                  .querySelector('[data-turn-source-count]')
                  ?.getAttribute('data-turn-source-count'),
              );
              if (
                selected &&
                p.oldGoneAt &&
                loadedHistoryCount > 0 &&
                (!active || p.liveAdvancedAt) &&
                !p.usefulPaintScheduled
              ) {
                p.usefulPaintScheduled = true;
                p.loadedHistoryCountAtFirstUseful = loadedHistoryCount;
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    p.usefulContentPaintAt = clock();
                  }),
                );
              }
              const historyCount = document.querySelectorAll(targetHistory).length;
              const swap = document.querySelector('.maka-chat-session-swap');
              const scroller = document.querySelector('[data-chat-scroll-container]');
              const viewport = scroller?.getBoundingClientRect();
              const inView = (node) => {
                if (!node || !viewport) return false;
                const rect = node.getBoundingClientRect();
                return (
                  rect.width > 0 &&
                  rect.height > 0 &&
                  rect.bottom > viewport.top &&
                  rect.top < viewport.bottom
                );
              };
              if (
                p.usefulContentPaintAt &&
                !p.fadeCompleteScheduled &&
                swap?.hasAttribute('data-placed') &&
                Number(getComputedStyle(swap).opacity) >= 0.99 &&
                (active ? inView(live) : [...document.querySelectorAll(targetHistory)].some(inView))
              ) {
                p.fadeCompleteScheduled = true;
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    p.fadeCompletePaintAt = clock();
                  }),
                );
              }
              const signature = `${selected}:${historyCount}:${anchor ? Math.round(anchor.getBoundingClientRect().height) : 'none'}`;
              if (signature !== p.lastSignature) {
                p.signatureSince = at;
                p.lastSignature = signature;
                p.signatureChanges++;
              }
              if (
                selected &&
                (anchor || liveLength > 0) &&
                at - p.signatureSince >= 500 &&
                !p.historySettledAt
              ) {
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    p.historySettledAt ??= clock();
                  }),
                );
              }
            }, 50);
          },
          {
            targetId,
            targetTurn: target.lastRenderableTurnId,
            sourceTurn: source.lastRenderableTurnId,
            enabled,
            active: state === 'active',
          },
        );
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
          button: 'left',
          clickCount: 1,
        });
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
          button: 'left',
          clickCount: 1,
        });
        await page.waitForFunction(
          (active) =>
            window.__matched5627.firstContentPaintAt &&
            (active ? window.__matched5627.liveAdvancedAt : window.__matched5627.anchorAt),
          state === 'active',
        );
        // Streaming autoscroll can keep virtualized historical rows moving.
        // Observe a bounded window and report no settled frame if it never
        // settles; never turn a stream continuing to update into a timeout.
        await delay(Number(values['settle-window-ms']));
        const raw = await page.evaluate(() => {
          const p = window.__matched5627;
          clearInterval(p.timer);
          const { timer, ...result } = p;
          return {
            ...result,
            observedUntilAt: performance.timeOrigin + performance.now(),
            transcript: window.maka5627Probe?.read() ?? [],
          };
        });
        const main = await app.evaluate(() => globalThis.__matched5627.events);
        assert(
          raw.fadeCompletePaintAt,
          'current-main target content must be placed and visibly faded in',
        );
        const afterReturn = await ask({ type: 'snapshot' });
        const afterReturnMetrics = await app.evaluate(({ app }) => app.getAppMetrics());
        const afterStream = afterReturn.streams[target.sessionId];
        assert.equal(Boolean(afterStream && !afterStream.endedAt), state === 'active');
        if (state === 'active') {
          assert(!afterReturn.streams[target.sessionId].endedAt);
          assert(
            afterReturn.streams[target.sessionId].deltas >
              beforeReturn.streams[target.sessionId].deltas,
          );
          assert.equal(beforeStream.turnId, afterStream.turnId);
        }
        const sample = {
          state,
          run,
          probe: enabled,
          addedRttMs: 2 * oneWayMs,
          startAt: raw.startAt,
          settledDuringObservation: raw.historySettledAt !== undefined,
          layoutObservation: {
            postFirstFrameMs: Number(values['settle-window-ms']),
            signatureChanges: raw.signatureChanges,
            lastSignatureChangeMs: raw.signatureSince - raw.startAt,
            quietAtEnd: raw.observedUntilAt - raw.signatureSince >= 500,
          },
          loadedHistoryCountAtFirstUseful: raw.loadedHistoryCountAtFirstUseful,
          times: Object.fromEntries(
            Object.entries(raw)
              .filter(([k, v]) => k.endsWith('At') && typeof v === 'number')
              .map(([k, v]) => [k, Math.round((v - raw.startAt) * 10) / 10]),
          ),
          activeEvidence: {
            beforeAway: beforeAway.streams[target.sessionId],
            beforeReturn: beforeReturn.streams[target.sessionId],
            afterReturn: afterStream,
            runningTurnIds: state === 'active' ? [afterStream.turnId] : [],
          },
          transcript: raw.transcript,
          main,
          resources: {
            beforeAway: {
              host: { cpu: beforeAway.cpu, memory: beforeAway.memory },
              desktop: beforeAwayMetrics,
            },
            beforeReturn: {
              host: { cpu: beforeReturn.cpu, memory: beforeReturn.memory },
              desktop: beforeReturnMetrics,
            },
            afterReturn: {
              host: { cpu: afterReturn.cpu, memory: afterReturn.memory },
              desktop: afterReturnMetrics,
            },
          },
          awayWire: beforeReturn.wire,
          returnWire: afterReturn.wire,
        };
        report.samples.push(sample);
        delete report.currentAttempt;
        console.log(
          JSON.stringify({ state, run, addedRttMs: sample.addedRttMs, times: sample.times }),
        );
        await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
        await cdp.detach();
      }
    }
    if (state === 'active') {
      await page.evaluate((id) => window.maka.sessions.stop(id), targetId);
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await ask({ type: 'snapshot' })).streams[target.sessionId].endedAt) break;
        await delay(100);
      }
      assert((await ask({ type: 'snapshot' })).streams[target.sessionId].endedAt);
    }
  }
  await page.screenshot({ path: join(output, 'final.png') });
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error.stack;
  report.failureProbe = await page?.evaluate(() => window.__matched5627).catch(() => null);
  console.error(error);
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  if (host && host.exitCode === null) {
    sendHost({ type: 'close' });
    await Promise.race([new Promise((r) => host.once('exit', r)), delay(10000)]);
    if (host.exitCode === null) host.kill('SIGTERM');
  }
  if (containerName) {
    try {
      execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
    } catch {}
  }
  if (oldPreload !== undefined) await writeFile(preloadPath, oldPreload);
  report.completedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(output, 'host.log'), hostLog.join(''));
  await writeFile(join(output, 'desktop.log'), desktopLog.join(''));
}
if (!report.ok) process.exitCode = 1;
