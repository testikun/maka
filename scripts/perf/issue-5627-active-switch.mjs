#!/usr/bin/env node
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

import { spawn, execFile, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import electronPath from 'electron';
import { buildFixtureEnv, inactiveWindowPlatformArgs } from '../fixture-env.mjs';
import { connect, median } from './cdp-client.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DESKTOP = join(ROOT, 'apps/desktop');
const EDITOR = '.maka-composer-editor [contenteditable="true"]';
const { values } = parseArgs({
  options: {
    manifest: { type: 'string' },
    output: { type: 'string' },
    runs: { type: 'string', default: '5' },
    'timeout-ms': { type: 'string', default: '120000' },
    'stream-bytes': { type: 'string', default: '6000' },
    'dev-server-url': { type: 'string' },
    'target-session-id': { type: 'string' },
    'source-session-id': { type: 'string' },
    state: { type: 'string', default: 'both' },
    profile: { type: 'boolean', default: false },
    executable: { type: 'string' },
    label: { type: 'string' },
    'source-dwell-ms': { type: 'string', default: '0' },
    'observe-ms': { type: 'string', default: '0' },
    'first-access': { type: 'boolean', default: false },
    'first-input': { type: 'boolean', default: false },
  },
});

if (!values.manifest || !values.output) {
  throw new Error('Required: --manifest <manifest.json> --output <report directory>');
}
const manifestPath = resolve(values.manifest);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const output = resolve(values.output);
const runs = positive(values.runs);
const timeoutMs = positive(values['timeout-ms']);
const streamBytes = positive(values['stream-bytes']);
const sourceDwellMs = Number(values['source-dwell-ms']);
const observeMs = Number(values['observe-ms']);
if (![sourceDwellMs, observeMs].every((value) => Number.isFinite(value) && value >= 0)) {
  throw new Error('Observation durations must be nonnegative milliseconds');
}
const state = values.state;
if (!['idle', 'active', 'both'].includes(state)) {
  throw new Error('--state must be idle, active, or both');
}
if (values.profile && (runs !== 1 || state !== 'idle')) {
  throw new Error('--profile requires --runs 1 --state idle');
}
const devServerOrigin = values['dev-server-url']
  ? new URL(values['dev-server-url']).origin
  : undefined;
const userData = resolve(manifest.userDataDir);
if (!userData.startsWith(join(ROOT, 'artifacts') + '/')) {
  throw new Error('Only a fixture under this worktree artifacts/ directory may be launched');
}

const target = values['target-session-id']
  ? findManifestSession(manifest, values['target-session-id'], 'target')
  : manifest.showcases?.['dense-active-root'];
if (!target || target.archived || !target.lastRenderableTurnId) {
  throw new Error('The manifest has no usable dense-active-root showcase');
}
const targetEntry = manifest.sessionMap.find((entry) => entry.sessionId === target.sessionId);
if (!targetEntry) throw new Error('The dense target is absent from sessionMap');
const targetTurnBase = target.lastRenderableTurnId.replace(/_t\d+_turn$/, '');

await mkdir(output, { recursive: true });
const report = {
  schemaVersion: 1,
  label: values.label ?? null,
  issue: 5627,
  startedAt: new Date().toISOString(),
  environment: {
    commit: process.env.MAKA_BENCH_COMMIT ?? 'unknown',
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpu: os.cpus()[0]?.model,
    memoryBytes: os.totalmem(),
    node: process.version,
    electron: JSON.parse(await readFile(join(ROOT, 'node_modules/electron/package.json'), 'utf8'))
      .version,
    executable: values.executable ? resolve(values.executable) : electronPath,
    renderer: values['dev-server-url']
      ? `Vite development server (${values['dev-server-url']})`
      : values.executable
        ? 'packaged production build'
        : 'vite production build',
    host: values.executable
      ? 'real isolated local Host using packaged production composition'
      : 'real isolated owned_ephemeral Host with the E2E FakeBackend',
  },
  fixture: {
    scenarioFingerprint: manifest.scenarioFingerprint,
    sessions: manifest.totals.sessions,
    turns: manifest.totals.turns,
    tools: manifest.totals.tools,
    target: {
      sessionId: target.sessionId,
      name: target.name,
      turns: target.turns,
      tools: target.tools,
      payloadBytes: target.payloadBytes,
    },
  },
  method: {
    runsPerState: runs,
    sourceDwellMs,
    observeMs,
    resourceWindow:
      'Entire target -> source -> target cycle plus fixed post-display observation; RSS sampled every 200 ms (sampled peak, not kernel high-water mark).',
    streamBytes,
    streamDescription:
      'A deterministic FakeBackend response emits one text delta about every 45 ms while the target is active.',
    milestones:
      'Renderer performance.now() from pointerdown to selected row, old transcript removal, first target turn, target anchor, and live bubble; stablePaintMs is anchor plus double RAF, not layout stability.',
    caveat:
      'Wall-clock samples run without CPU profiling. A --profile run is diagnostic and must not be mixed into timing medians.',
  },
  samples: { idle: [], active: [] },
};

let browser;
let child;
let inspector;
let processExited = false;
let mainInspectorUrl;
let page;
let rendererCdp;
let profileActive = false;
let hostSampler;
const log = [];
let firstAccessTimer;
let firstAccessPending = Promise.resolve();

try {
  const previousRegistration = await readFile(manifest.registrationPath, 'utf8')
    .then(JSON.parse)
    .catch(() => null);
  if (previousRegistration?.pid && alive(previousRegistration.pid)) {
    throw new Error('The fixture Host is still running');
  }

  const port = await freePort();
  const env = buildFixtureEnv(userData, manifest.homeDir, {
    locale: 'zh-CN',
    showWindow: true,
  });
  if (values['dev-server-url']) env.VITE_DEV_SERVER_URL = values['dev-server-url'];
  if (values.executable) {
    env.MAKA_UPDATE_TEST_USER_DATA_DIR = userData;
    env.MAKA_UPDATE_TEST_FEED = 'http://127.0.0.1:1/issue-5680-update-disabled';
  }
  delete env.ELECTRON_RUN_AS_NODE;
  if (values['first-access']) report.firstAccess = { spawnAt: Date.now() };
  child = spawn(
    values.executable ? resolve(values.executable) : electronPath,
    [
      `--remote-debugging-port=${port}`,
      '--inspect=0',
      ...inactiveWindowPlatformArgs(),
      ...(values.executable ? [] : ['.']),
    ],
    { cwd: DESKTOP, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.once('exit', (code, signal) => {
    processExited = true;
    report.exit = { code, signal };
  });
  const capture = (stream, bytes) => {
    const text = bytes.toString();
    log.push({ at: new Date().toISOString(), stream, text });
    if (stream === 'stderr') {
      mainInspectorUrl ??= text.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1];
    }
  };
  child.stdout.on('data', (bytes) => capture('stdout', bytes));
  child.stderr.on('data', (bytes) => capture('stderr', bytes));
  if (values['first-access']) {
    let busy = false;
    firstAccessTimer = setInterval(() => {
      if (busy) return;
      busy = true;
      firstAccessPending = readFile(manifest.registrationPath, 'utf8')
        .then(JSON.parse)
        .then((r) => {
          if (r.hostEpoch === previousRegistration?.hostEpoch || !alive(r.pid)) return;
          const key = `${r.state}ObservedAt`;
          report.firstAccess[key] ??= Date.now();
          if (r.state === 'ready') clearInterval(firstAccessTimer);
        })
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    }, 25);
  }

  await until(
    async () => {
      if (processExited) throw new Error('Electron exited before CDP became available');
      try {
        return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
      } catch {
        return false;
      }
    },
    timeoutMs,
    'CDP endpoint',
  );

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
    timeout: timeoutMs,
  });
  await until(
    () => {
      page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => {
          const url = candidate.url();
          return (
            !url.includes('surface=') &&
            (devServerOrigin
              ? url.startsWith(devServerOrigin)
              : url.includes('dist-renderer/index.html'))
          );
        });
      return Boolean(page);
    },
    timeoutMs,
    'main Renderer page',
  );
  if (values['first-access']) {
    const observe = ({ turnId }) => {
      if (globalThis.__firstAccess) return;
      const now = () => performance.timeOrigin + performance.now();
      const probe = (globalThis.__firstAccess = {
        installedAt: now(),
        timeOrigin: performance.timeOrigin,
      });
      const scan = () => {
        if (document.querySelector('.maka-composer-editor [contenteditable="true"]'))
          probe.composerDomAt ??= now();
        if (document.querySelector(`[data-turn-id^="${CSS.escape(turnId)}"]`)) {
          if (probe.anchorDomAt === undefined) {
            probe.anchorDomAt = now();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                probe.contentFrameAt = now();
              }),
            );
          }
        }
      };
      const observer = new MutationObserver(scan);
      observer.observe(document, { subtree: true, childList: true, attributes: true });
      scan();
      probe.alreadyPresentAtInstall = probe.anchorDomAt !== undefined;
    };
    await page.addInitScript(observe, { turnId: target.lastRenderableTurnId });
    await page.evaluate(observe, { turnId: target.lastRenderableTurnId }).catch(() => {});
  }
  await page.locator(EDITOR).first().waitFor({ state: 'visible', timeout: timeoutMs });
  await ensureSidebarExpanded(page);
  const hostRegistration = await until(
    async () => {
      const registration = await readFile(manifest.registrationPath, 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      return registration?.state === 'ready' &&
        registration.hostEpoch !== previousRegistration?.hostEpoch &&
        alive(registration.pid)
        ? registration
        : false;
    },
    timeoutMs,
    'new fixture Host ready registration',
  );
  report.hostRegistration = {
    pid: hostRegistration.pid,
    hostEpoch: hostRegistration.hostEpoch,
    state: hostRegistration.state,
  };

  const targetUiSessionId = await resolveUiSessionIdByTitle(page, target.name, timeoutMs);
  if (values['first-input']) {
    if (!values['first-access']) throw new Error('--first-input requires --first-access');
    const targetRow = page.locator(`[data-session-id=${JSON.stringify(targetUiSessionId)}]`);
    if (!(await targetRow.locator('[aria-current="page"]').count())) {
      await targetRow.click({ timeout: timeoutMs });
    }
    await page.waitForFunction(
      ({ id, editor }) =>
        document
          .querySelector(`[data-session-id="${CSS.escape(id)}"]`)
          ?.querySelector('[aria-current="page"]') &&
        document.querySelector(editor)?.isContentEditable,
      { id: targetUiSessionId, editor: EDITOR },
      { timeout: timeoutMs },
    );
    const input = page.locator(EDITOR).first();
    if ((await input.innerText()).trim())
      throw new Error('First input fixture draft must be empty');
    await page.evaluate(
      ({ editor, id }) => {
        const node = document.querySelector(editor),
          now = () => performance.timeOrigin + performance.now();
        const p = (globalThis.__firstInput = {
          eligibleObservedAt: now(),
          targetUiSessionId: id,
          keys: [],
        });
        node.addEventListener('keydown', (e) => {
          if (e.key.length === 1) {
            p.keys.push({ key: e.key, at: now() });
            p.firstKeyAt ??= now();
          }
        });
        const scan = () => {
          const text = node.textContent ?? '';
          if (text.startsWith('x') && p.firstCharDomAt === undefined) {
            p.firstCharDomAt = now();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                p.firstCharFrameAt = now();
              }),
            );
          }
          if (text === 'xperf5680' && p.allTextDomAt === undefined) {
            p.allTextDomAt = now();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                p.allTextFrameAt = now();
              }),
            );
          }
        };
        new MutationObserver(scan).observe(node, {
          subtree: true,
          childList: true,
          characterData: true,
        });
      },
      { editor: EDITOR, id: targetUiSessionId },
    );
    await input.click({ timeout: timeoutMs });
    await page.keyboard.type('xperf5680');
    await page.waitForFunction(
      () => globalThis.__firstInput?.allTextFrameAt !== undefined,
      undefined,
      { timeout: timeoutMs },
    );
    await page.waitForTimeout(1500);
    report.firstInput = await page.evaluate(
      ({ editor, id }) => {
        const node = document.querySelector(editor),
          send = node?.closest('form')?.querySelector('button[type="submit"]');
        return {
          ...globalThis.__firstInput,
          verifiedAt: performance.timeOrigin + performance.now(),
          draft: node?.textContent,
          stillSelected: !!document
            .querySelector(`[data-session-id="${CSS.escape(id)}"]`)
            ?.querySelector('[aria-current="page"]'),
          sendButton: send
            ? {
                disabled: send.disabled,
                label: send.getAttribute('aria-label'),
                title: send.getAttribute('title'),
              }
            : null,
        };
      },
      { editor: EDITOR, id: targetUiSessionId },
    );
    if (report.firstInput.draft !== 'xperf5680' || !report.firstInput.stillSelected)
      throw new Error('Input was lost or moved to another session during startup');
    await input.fill('');
  }
  await selectSession(page, targetUiSessionId, target.lastRenderableTurnId, timeoutMs);
  if (values['first-access']) {
    await page.waitForFunction(
      () => globalThis.__firstAccess?.contentFrameAt !== undefined,
      undefined,
      { timeout: timeoutMs },
    );
    report.firstAccess.renderer = await page.evaluate(() => ({
      ...globalThis.__firstAccess,
      transcripts: window.maka5627Probe?.read(),
    }));
    report.firstAccess.hostCpuAndRssAtContent = execFileSync(
      'ps',
      ['-p', String(hostRegistration.pid), '-o', 'cputime=', '-o', 'rss='],
      { encoding: 'utf8' },
    ).trim();
    report.firstAccess.capturedAt = Date.now();
    console.log(JSON.stringify({ stage: 'first-access', ...report.firstAccess }));
  }
  const source = values['source-session-id']
    ? await resolveExplicitSource(
        page,
        manifest,
        values['source-session-id'],
        targetUiSessionId,
        timeoutMs,
      )
    : await chooseVisibleSource(page, manifest, targetUiSessionId);
  report.fixture.target.uiSessionId = targetUiSessionId;
  report.fixture.source = {
    sessionId: source.sessionId,
    uiSessionId: source.uiSessionId,
    name: source.name,
    turnId: source.lastRenderableTurnId,
  };

  if (values.profile) {
    await selectSession(page, source.uiSessionId, source.lastRenderableTurnId, timeoutMs);
    await until(() => Boolean(mainInspectorUrl), 5000, 'Main inspector endpoint');
    inspector = connect(mainInspectorUrl);
    await inspector.ready;
    rendererCdp = await page.context().newCDPSession(page);
    await inspector.send('Profiler.enable');
    await inspector.send('Profiler.setSamplingInterval', { interval: 1000 });
    await rendererCdp.send('Profiler.enable');
    await rendererCdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    hostSampler = sampleNativeProcess(hostRegistration.pid, 20, join(output, 'host.sample.txt'));
    await Promise.all([inspector.send('Profiler.start'), rendererCdp.send('Profiler.start')]);
    profileActive = true;
  }

  if (state !== 'active') {
    const readResources = async () => {
      const connection = await browser.newBrowserCDPSession();
      const chromium = await connection.send('SystemInfo.getProcessInfo');
      await connection.detach();
      return {
        at: Date.now(),
        chromium,
        host: execFileSync(
          'ps',
          ['-p', String(hostRegistration.pid), '-o', 'cputime=', '-o', 'rss='],
          { encoding: 'utf8' },
        ).trim(),
        main: execFileSync('ps', ['-p', String(child.pid), '-o', 'cputime=', '-o', 'rss='], {
          encoding: 'utf8',
        }).trim(),
      };
    };
    for (let run = 1; run <= runs; run += 1) {
      const cycleBefore = await readResources();
      const pids = [
        hostRegistration.pid,
        child.pid,
        ...cycleBefore.chromium.processInfo.filter((p) => p.type === 'renderer').map((p) => p.id),
      ];
      const memorySamples = [];
      let memoryPending = Promise.resolve();
      let memoryBusy = false;
      const memoryTimer = setInterval(() => {
        if (memoryBusy) return;
        memoryBusy = true;
        memoryPending = new Promise((done) => {
          execFile(
            'ps',
            ['-p', pids.join(','), '-o', 'pid=', '-o', 'rss='],
            { encoding: 'utf8' },
            (error, stdout) => {
              memorySamples.push({ at: Date.now(), rows: stdout.trim(), error: error?.message });
              memoryBusy = false;
              done();
            },
          );
        });
      }, 200);
      try {
        await selectSession(page, source.uiSessionId, source.lastRenderableTurnId, timeoutMs);
        if (sourceDwellMs) await new Promise((done) => setTimeout(done, sourceDwellMs));
        const before = await readResources();
        const sample = await measureSwitch({
          page,
          targetUiSessionId,
          targetTurnBase,
          targetAnchorTurnId: target.lastRenderableTurnId,
          sourceTurnId: source.lastRenderableTurnId,
          run,
          active: false,
          timeoutMs,
        });
        sample.resources = { before, after: await readResources() };
        if (observeMs) await new Promise((done) => setTimeout(done, observeMs));
        sample.resources.cycleBefore = cycleBefore;
        sample.resources.observedAfter = await readResources();
        clearInterval(memoryTimer);
        await memoryPending;
        sample.resources.memorySamples = memorySamples;
        report.samples.idle.push(sample);
        await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ stage: 'idle', ...sample }));
      } finally {
        clearInterval(memoryTimer);
        await memoryPending;
      }
    }
  }

  if (values.profile) {
    const [mainResult, rendererResult] = await Promise.all([
      inspector.send('Profiler.stop'),
      rendererCdp.send('Profiler.stop'),
    ]);
    profileActive = false;
    await Promise.all([
      writeFile(join(output, 'main.cpuprofile'), JSON.stringify(mainResult.profile)),
      writeFile(join(output, 'renderer.cpuprofile'), JSON.stringify(rendererResult.profile)),
    ]);
    report.profiles = {
      main: summarizeCpuProfile(mainResult.profile),
      renderer: summarizeCpuProfile(rendererResult.profile),
      hostNative: await hostSampler,
    };
  }

  if (state !== 'idle') {
    await selectSession(page, targetUiSessionId, target.lastRenderableTurnId, timeoutMs);
    const streamPrompt = `__issue_5627_stream__${'x'.repeat(streamBytes)}`;
    const submission = await page.evaluate(
      async ({ sessionId, text }) =>
        window.maka.sessions.submitMessage(
          sessionId,
          'next_turn',
          { messageId: crypto.randomUUID(), text },
          { waitForHostAdmission: true },
        ),
      { sessionId: targetUiSessionId, text: streamPrompt },
    );
    if (!submission.ok)
      throw new Error(`Unable to start active target: ${JSON.stringify(submission)}`);
    await page.waitForFunction(
      () =>
        document
          .querySelector('.maka-bubble-streaming')
          ?.textContent?.includes('__issue_5627_stream__'),
      undefined,
      { timeout: timeoutMs },
    );

    for (let run = 1; run <= runs; run += 1) {
      await selectSession(page, source.uiSessionId, source.lastRenderableTurnId, timeoutMs);
      const sample = await measureSwitch({
        page,
        targetUiSessionId,
        targetTurnBase,
        targetAnchorTurnId: target.lastRenderableTurnId,
        sourceTurnId: source.lastRenderableTurnId,
        run,
        active: true,
        timeoutMs,
      });
      report.samples.active.push(sample);
      console.log(JSON.stringify({ stage: 'active', ...sample }));
    }

    await page.evaluate((sessionId) => window.maka.sessions.stop(sessionId), targetUiSessionId);
    await page.waitForFunction(
      async (sessionId) => {
        const session = await window.maka.sessions.get(sessionId);
        return session?.runningTurnIds.length === 0;
      },
      targetUiSessionId,
      { timeout: timeoutMs },
    );
    report.staleStreamingBubbleAfterStop = await page.locator('.maka-bubble-streaming').isVisible();
  }
  await page.screenshot({ path: join(output, 'final.png') });
  report.summary = summarizeSamples(report.samples);
  report.completedAt = new Date().toISOString();
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error instanceof Error ? error.stack : String(error);
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
} finally {
  clearInterval(firstAccessTimer);
  await firstAccessPending;
  if (profileActive) {
    await Promise.all([
      inspector?.send('Profiler.stop').catch(() => undefined),
      rendererCdp?.send('Profiler.stop').catch(() => undefined),
    ]);
  }
  if (hostSampler && !report.profiles?.hostNative) await hostSampler;
  await writeFile(join(output, 'main-log.json'), `${JSON.stringify(log, null, 2)}\n`);
  if (child && !processExited) {
    try {
      await until(() => Boolean(mainInspectorUrl), 5000, 'Main inspector endpoint');
      if (!inspector) {
        inspector = connect(mainInspectorUrl);
        await inspector.ready;
      }
      const requireElectron = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(DESKTOP, 'package.json'))})('electron')`;
      await inspector.evaluate(`setTimeout(()=>${requireElectron}.app.quit(),50); true`);
    } catch {
      child.kill('SIGTERM');
    }
    await browser?.close().catch(() => {});
    await until(() => processExited, 10000, 'graceful Electron exit').catch(() => {
      child.kill('SIGKILL');
    });
  } else {
    await browser?.close().catch(() => {});
  }
  inspector?.close();
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

console.log(
  JSON.stringify({ ok: report.ok, summary: report.summary, error: report.error }, null, 2),
);
if (!report.ok) process.exitCode = 1;

async function measureSwitch({
  page,
  targetUiSessionId,
  targetTurnBase,
  targetAnchorTurnId,
  sourceTurnId,
  run,
  active,
  timeoutMs,
}) {
  const row = page.locator(`[data-session-id=${JSON.stringify(targetUiSessionId)}]`);
  await row.scrollIntoViewIfNeeded();
  const bridgeWrapped = await page.evaluate((targetSessionId) => {
    globalThis.__makaIssue5627TranscriptPerf = true;
    window.maka5627Probe?.reset(true);
    for (const name of [
      'maka.issue5627.transcript.open',
      'maka.issue5627.transcript.open-resolved',
      'maka.issue5627.transcript.batch',
    ]) {
      performance.clearMarks(name);
    }
    const transcripts = window.maka.transcripts;
    const original = transcripts.open;
    const trace = {
      targetSessionId,
      openCalledAt: undefined,
      openResolvedAt: undefined,
      firstBatchAt: undefined,
      readyBatchAt: undefined,
      readyBatchHandledAt: undefined,
      batches: 0,
      fragments: 0,
      bytes: 0,
      handlerMs: 0,
    };
    globalThis.__issue5627TranscriptTrace = trace;
    const wrapped = async (sessionId, handler, registerCancellation, mode, resumeFrom) => {
      if (sessionId !== targetSessionId) {
        return original(sessionId, handler, registerCancellation, mode, resumeFrom);
      }
      trace.openCalledAt = performance.now();
      const result = await original(
        sessionId,
        (batch) => {
          const enteredAt = performance.now();
          trace.firstBatchAt ??= enteredAt;
          trace.batches += 1;
          trace.fragments += batch.fragments.length;
          trace.bytes += batch.fragments.reduce(
            (total, fragment) => total + fragment.data.byteLength,
            0,
          );
          if (batch.ready) trace.readyBatchAt = enteredAt;
          handler(batch);
          const handledAt = performance.now();
          trace.handlerMs += handledAt - enteredAt;
          if (batch.ready) trace.readyBatchHandledAt = handledAt;
        },
        registerCancellation,
        mode,
        resumeFrom,
      );
      trace.openResolvedAt = performance.now();
      return result;
    };
    try {
      transcripts.open = wrapped;
      globalThis.__issue5627RestoreTranscriptOpen = () => {
        try {
          transcripts.open = original;
        } catch {}
      };
      return transcripts.open === wrapped;
    } catch (error) {
      trace.wrapError = String(error);
      return false;
    }
  }, targetUiSessionId);
  await page.evaluate(
    ({ targetSessionId, targetTurnBase, targetAnchorTurnId, sourceTurnId, active }) => {
      globalThis.__issue5627Probe?.observer?.disconnect();
      const probe = {
        startAt: undefined,
        lastMutationAt: performance.now(),
        selectedAt: undefined,
        oldGoneAt: undefined,
        firstTargetTurnAt: undefined,
        targetAnchorAt: undefined,
        liveAt: undefined,
        targetSessionId,
        targetTurnBase,
        sourceTurnId,
        active,
        longTasks: [],
      };
      const sample = () => {
        if (probe.startAt === undefined) return;
        const now = performance.now();
        const row = document.querySelector(`[data-session-id="${CSS.escape(targetSessionId)}"]`);
        if (probe.selectedAt === undefined && row?.querySelector('[aria-current="page"]')) {
          probe.selectedAt = now;
        }
        if (
          probe.oldGoneAt === undefined &&
          !document.querySelector(`[data-turn-id^="${CSS.escape(sourceTurnId)}"]`)
        ) {
          probe.oldGoneAt = now;
        }
        const turnIds = new Set(
          [...document.querySelectorAll('[data-turn-id]')]
            .map((node) => node.getAttribute('data-turn-id'))
            .filter((id) => id?.startsWith(`${targetTurnBase}_t`)),
        );
        if (probe.firstTargetTurnAt === undefined && turnIds.size > 0) {
          probe.firstTargetTurnAt = now;
        }
        if (
          probe.targetAnchorAt === undefined &&
          document.querySelector(`[data-turn-id^="${CSS.escape(targetAnchorTurnId)}"]`)
        ) {
          probe.targetAnchorAt = now;
        }
        if (
          probe.liveAt === undefined &&
          document
            .querySelector('.maka-bubble-streaming')
            ?.textContent?.includes('__issue_5627_stream__')
        ) {
          probe.liveAt = now;
        }
      };
      const observer = new MutationObserver(() => {
        probe.lastMutationAt = performance.now();
        sample();
      });
      observer.observe(document.body, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      const longTaskObserver = new PerformanceObserver((list) => {
        probe.longTasks.push(
          ...list.getEntries().map((entry) => ({
            startTime: entry.startTime,
            duration: entry.duration,
          })),
        );
      });
      longTaskObserver.observe({ type: 'longtask', buffered: false });
      probe.observer = observer;
      probe.longTaskObserver = longTaskObserver;
      probe.sample = sample;
      globalThis.__issue5627Probe = probe;
      document.addEventListener(
        'pointerdown',
        () => {
          probe.startAt = performance.now();
        },
        { once: true, capture: true },
      );
      sample();
    },
    {
      targetSessionId: targetUiSessionId,
      targetTurnBase,
      targetAnchorTurnId,
      sourceTurnId,
      active,
    },
  );

  const clickStarted = performance.now();
  await row.click({ timeout: timeoutMs });
  const clickRoundTripMs = round(performance.now() - clickStarted);
  await page.evaluate(() => {
    globalThis.__issue5627Probe.clickCompletedAt = performance.now();
  });
  await page.waitForFunction(
    () => {
      const probe = globalThis.__issue5627Probe;
      probe?.sample?.();
      return Boolean(
        probe?.selectedAt !== undefined &&
          (probe.active ? probe.liveAt !== undefined : probe.targetAnchorAt !== undefined),
      );
    },
    undefined,
    { timeout: timeoutMs },
  );
  const paintedAt = await page.evaluate(
    () =>
      new Promise((resolvePaint) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolvePaint(performance.now())));
      }),
  );
  const raw = await page.evaluate((bridgeWasWrapped) => {
    const probe = globalThis.__issue5627Probe;
    probe.observer.disconnect();
    probe.longTaskObserver.disconnect();
    globalThis.__issue5627RestoreTranscriptOpen?.();
    const batches = performance
      .getEntriesByName('maka.issue5627.transcript.batch', 'mark')
      .map((entry) => entry.detail);
    const readyBatch = batches.find((batch) => batch.ready);
    const preloadAttempts =
      window.maka5627Probe?.read()?.filter((entry) => entry.sessionId === probe.targetSessionId) ??
      [];
    const preload = preloadAttempts[0];
    const preloadReady = preload?.batches.find((entry) => entry.ready);
    const sourceTrace = preload?.batches.length
      ? {
          openCalledAt: preload.openedAt - performance.timeOrigin,
          openResolvedAt:
            preload.resolvedAt === undefined
              ? undefined
              : preload.resolvedAt - performance.timeOrigin,
          firstBatchAt: preload.batches[0].at - performance.timeOrigin,
          readyBatchAt: preloadReady?.at - performance.timeOrigin,
          readyBatchHandledAt: preloadReady?.handledAt - performance.timeOrigin,
          batches: preload.batches.length,
          bytes: preload.batches.reduce((total, entry) => total + entry.bytes, 0),
          handlerMs: preload.batches.reduce(
            (total, entry) => total + entry.handledAt - entry.at,
            0,
          ),
          source: 'preload-probe',
        }
      : batches.length
        ? {
            openCalledAt: performance.getEntriesByName('maka.issue5627.transcript.open', 'mark')[0]
              ?.startTime,
            openResolvedAt: performance.getEntriesByName(
              'maka.issue5627.transcript.open-resolved',
              'mark',
            )[0]?.startTime,
            firstBatchAt: batches[0]?.enteredAt,
            readyBatchAt: readyBatch?.enteredAt,
            readyBatchHandledAt: readyBatch?.handledAt,
            batches: batches.length,
            fragments: batches.reduce((total, batch) => total + batch.fragments, 0),
            bytes: batches.reduce((total, batch) => total + batch.bytes, 0),
            handlerMs: batches.reduce((total, batch) => total + batch.durationMs, 0),
            source: 'temporary-renderer-source-marks',
          }
        : undefined;
    globalThis.__makaIssue5627TranscriptPerf = false;
    return {
      startAt: probe.startAt,
      clickCompletedAt: probe.clickCompletedAt,
      selectedAt: probe.selectedAt,
      oldGoneAt: probe.oldGoneAt,
      firstTargetTurnAt: probe.firstTargetTurnAt,
      targetAnchorAt: probe.targetAnchorAt,
      liveAt: probe.liveAt,
      longTasks: probe.longTasks,
      transcriptAttempts: preloadAttempts.map((entry) => ({
        openedMs: entry.openedAt - performance.timeOrigin - probe.startAt,
        resolvedMs:
          entry.resolvedAt === undefined
            ? undefined
            : entry.resolvedAt - performance.timeOrigin - probe.startAt,
        batches: entry.batches.map((batch) => ({
          ...batch,
          at: batch.at - performance.timeOrigin - probe.startAt,
          handledAt: batch.handledAt - performance.timeOrigin - probe.startAt,
        })),
      })),
      transcript: bridgeWasWrapped
        ? globalThis.__issue5627TranscriptTrace
        : (sourceTrace ?? globalThis.__issue5627TranscriptTrace),
    };
  }, bridgeWrapped);
  await page.waitForFunction(
    () => {
      const swap = document.querySelector('.maka-chat-session-swap');
      return swap?.hasAttribute('data-placed') && Number(getComputedStyle(swap).opacity) >= 0.99;
    },
    undefined,
    { timeout: timeoutMs },
  );
  const fadeCompletePaintAt = await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))),
      ),
  );
  const offset = (value) => (value === undefined ? undefined : round(value - raw.startAt));
  const readyAt = active ? Math.max(raw.selectedAt, raw.liveAt) : raw.targetAnchorAt;
  return {
    run,
    active,
    clickRoundTripMs,
    clickCompletedMs: offset(raw.clickCompletedAt),
    selectionVisibleMs: offset(raw.selectedAt),
    oldTranscriptGoneMs: offset(raw.oldGoneAt),
    firstTargetTurnVisibleMs: offset(raw.firstTargetTurnAt),
    targetAnchorVisibleMs: offset(raw.targetAnchorAt),
    liveBubbleVisibleMs: offset(raw.liveAt),
    readyVisibleMs: offset(readyAt),
    stablePaintMs: offset(paintedAt),
    fadeCompletePaintMs: offset(fadeCompletePaintAt),
    bridgeWrapped,
    transcriptAttempts: raw.transcriptAttempts,
    transcript: raw.transcript
      ? {
          openCalledMs: offset(raw.transcript.openCalledAt),
          firstBatchMs: offset(raw.transcript.firstBatchAt),
          readyBatchMs: offset(raw.transcript.readyBatchAt),
          readyBatchHandledMs: offset(raw.transcript.readyBatchHandledAt),
          openResolvedMs: offset(raw.transcript.openResolvedAt),
          batches: raw.transcript.batches,
          fragments: raw.transcript.fragments,
          bytes: raw.transcript.bytes,
          handlerMs: round(raw.transcript.handlerMs),
          source: raw.transcript.source ?? (bridgeWrapped ? 'bridge-wrapper' : undefined),
          wrapError: raw.transcript.wrapError,
        }
      : null,
    oldTranscriptRemainedAfterSelection:
      raw.oldGoneAt === undefined || raw.selectedAt === undefined
        ? null
        : raw.oldGoneAt > raw.selectedAt,
    longTasks: raw.longTasks
      .filter((entry) => entry.startTime >= raw.startAt && entry.startTime <= readyAt)
      .map((entry) => ({
        startMs: round(entry.startTime - raw.startAt),
        durationMs: round(entry.duration),
      })),
  };
}

async function selectSession(page, sessionId, turnId, timeoutMs) {
  const row = page.locator(`[data-session-id=${JSON.stringify(sessionId)}]`);
  await row.scrollIntoViewIfNeeded();
  if (!(await row.locator('[aria-current="page"]').count())) {
    await row.click({ timeout: timeoutMs });
  }
  await page.waitForFunction(
    (id) =>
      Boolean(
        document
          .querySelector(`[data-session-id="${CSS.escape(id)}"]`)
          ?.querySelector('[aria-current="page"]'),
      ),
    sessionId,
    { timeout: timeoutMs },
  );
  await page
    .locator(`[data-turn-id^=${JSON.stringify(turnId)}]`)
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs });
}

async function chooseVisibleSource(page, manifest, targetSessionId) {
  const visibleIds = await page
    .locator('nav.maka-session-panel [data-session-id]')
    .evaluateAll((rows) =>
      rows
        .filter((row) => {
          const box = row.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight;
        })
        .map((row) => row.getAttribute('data-session-id'))
        .filter(Boolean),
    );
  const source = visibleIds
    .filter((id) => id !== targetSessionId)
    .map((uiSessionId) => ({
      uiSessionId,
      entry: manifest.sessionMap.find((entry) => entry.sessionId === rawSessionId(uiSessionId)),
    }))
    .find(({ entry }) => entry?.lastRenderableTurnId && !entry.archived);
  if (!source) throw new Error('No visible source Session with renderable history was found');
  return { ...source.entry, uiSessionId: source.uiSessionId };
}

async function resolveExplicitSource(page, manifest, identity, targetSessionId, timeoutMs) {
  const entry = findManifestSession(manifest, identity, 'source');
  if (entry.archived || !entry.lastRenderableTurnId) {
    throw new Error('The requested source Session has no active renderable history');
  }
  const uiSessionId = await resolveUiSessionIdByTitle(page, entry.name, timeoutMs);
  if (uiSessionId === targetSessionId) {
    throw new Error('Source and target Sessions must differ');
  }
  return { ...entry, uiSessionId };
}

function findManifestSession(manifest, identity, label) {
  const entry = manifest.sessionMap.find(
    (candidate) => candidate.sessionId === identity || candidate.syntheticId === identity,
  );
  if (!entry) throw new Error(`Unknown ${label} Session: ${identity}`);
  return entry;
}

async function resolveUiSessionIdByTitle(page, title, timeoutMs) {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const button = page
    .getByRole('navigation', { name: /^(任务列表|Task list)$/ })
    .getByRole('button', { name: new RegExp(`^${escapedTitle}(?:\\s|$)`) })
    .first();
  await button.waitFor({ state: 'visible', timeout: timeoutMs });
  const sessionId = await button.evaluate(
    (node) => node.closest('[data-session-id]')?.getAttribute('data-session-id') ?? null,
  );
  if (!sessionId) throw new Error(`Unable to resolve the UI Session id for ${title}`);
  return sessionId;
}

function rawSessionId(uiSessionId) {
  try {
    const parsed = JSON.parse(uiSessionId);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return parsed[1];
    }
  } catch {}
  return uiSessionId;
}

async function ensureSidebarExpanded(page) {
  const expand = page.getByRole('button', { name: /^(展开侧边栏|Expand sidebar)$/ });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('navigation', { name: /^(任务列表|Task list)$/ }).waitFor({
    state: 'visible',
  });
}

function summarizeSamples(samples) {
  const fields = [
    'selectionVisibleMs',
    'oldTranscriptGoneMs',
    'firstTargetTurnVisibleMs',
    'targetAnchorVisibleMs',
    'liveBubbleVisibleMs',
    'readyVisibleMs',
    'stablePaintMs',
  ];
  const summarize = (group) =>
    Object.fromEntries(
      fields.flatMap((field) => {
        const values = group.map((sample) => sample[field]).filter(Number.isFinite);
        return values.length
          ? [
              [
                field,
                { median: median(values), min: Math.min(...values), max: Math.max(...values) },
              ],
            ]
          : [];
      }),
    );
  const idle = summarize(samples.idle);
  const active = summarize(samples.active);
  return {
    idle,
    active,
    idleStages: summarizeStages(samples.idle),
    activeStages: summarizeStages(samples.active),
    activeMinusIdleMedianMs: Object.fromEntries(
      fields.flatMap((field) =>
        idle[field] && active[field]
          ? [[field, round(active[field].median - idle[field].median)]]
          : [],
      ),
    ),
  };
}

function summarizeStages(group) {
  const complete = group.filter(
    (sample) =>
      (sample.bridgeWrapped || sample.transcript?.source) &&
      Number.isFinite(sample.transcript?.openCalledMs) &&
      Number.isFinite(sample.transcript?.firstBatchMs) &&
      Number.isFinite(sample.transcript?.readyBatchMs) &&
      Number.isFinite(sample.transcript?.readyBatchHandledMs),
  );
  if (complete.length === 0) return null;
  const medianOf = (read) => median(complete.map(read));
  const total = medianOf((sample) => sample.stablePaintMs);
  const stages = [
    ['clickToTranscriptOpen', medianOf((sample) => sample.transcript.openCalledMs)],
    [
      'openToFirstBatch',
      medianOf((sample) => sample.transcript.firstBatchMs - sample.transcript.openCalledMs),
    ],
    [
      'firstToReadyBatch',
      medianOf((sample) => sample.transcript.readyBatchMs - sample.transcript.firstBatchMs),
    ],
    [
      'readyBatchAccept',
      medianOf((sample) => sample.transcript.readyBatchHandledMs - sample.transcript.readyBatchMs),
    ],
    [
      'readyAcceptedToSelection',
      medianOf((sample) => sample.selectionVisibleMs - sample.transcript.readyBatchHandledMs),
    ],
    [
      'selectionToAnchor',
      medianOf((sample) => sample.targetAnchorVisibleMs - sample.selectionVisibleMs),
    ],
    [
      'anchorToStablePaint',
      medianOf((sample) => sample.stablePaintMs - sample.targetAnchorVisibleMs),
    ],
  ];
  return {
    sampleCount: complete.length,
    totalMedianMs: round(total),
    stages: stages.map(([name, ms]) => ({
      name,
      medianMs: round(ms),
      percentOfTotal: round((ms / total) * 100),
    })),
    batchCountMedian: medianOf((sample) => sample.transcript.batches),
    fragmentCountMedian: medianOf((sample) => sample.transcript.fragments),
    payloadBytesMedian: medianOf((sample) => sample.transcript.bytes),
    handlerCpuOverlayMedianMs: round(medianOf((sample) => sample.transcript.handlerMs)),
    handlerCpuOverlayPercent: round(
      (medianOf((sample) => sample.transcript.handlerMs) / total) * 100,
    ),
  };
}

function sampleNativeProcess(pid, seconds, path) {
  return new Promise((resolveSample) => {
    const sample = spawn('/usr/bin/sample', [String(pid), String(seconds), '1', '-file', path], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    sample.stderr.on('data', (bytes) => {
      stderr = (stderr + bytes).slice(-4000);
    });
    sample.once('error', (error) => resolveSample({ ok: false, error: String(error) }));
    sample.once('exit', (code) => resolveSample({ ok: code === 0, code, path, stderr }));
  });
}

function summarizeCpuProfile(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const totals = new Map();
  let sampledMs = 0;
  let idleMs = 0;
  for (let index = 0; index < (profile.samples ?? []).length; index += 1) {
    const node = nodes.get(profile.samples[index]);
    const ms = (profile.timeDeltas?.[index] ?? 0) / 1000;
    sampledMs += ms;
    const name = node?.callFrame?.functionName || '(anonymous)';
    if (name === '(idle)') idleMs += ms;
    const url = node?.callFrame?.url || '';
    const key = `${name} @${url.split('/').pop()}:${node?.callFrame?.lineNumber ?? 0}`;
    totals.set(key, (totals.get(key) ?? 0) + ms);
  }
  return {
    sampledMs: round(sampledMs),
    idleMs: round(idleMs),
    nonIdleMs: round(sampledMs - idleMs),
    topSelfTime: [...totals]
      .filter(([key]) => !key.startsWith('(idle)'))
      .sort((left, right) => right[1] - left[1])
      .slice(0, 30)
      .map(([frame, ms]) => ({ frame, ms: round(ms) })),
  };
}

function positive(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`Expected positive number: ${value}`);
  return parsed;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function until(check, timeout, label) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    const result = await check();
    if (result) return result;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
