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
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { useSessionSettingIntent } from '../../renderer/use-session-setting-intent.js';

type SessionSettingIntentController<Value> = ReturnType<
  typeof useSessionSettingIntent<Value>
>;

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

let mountedRoot: Root | undefined;

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});

test('Runtime leaving Plan after approval supersedes the committed Plan overlay', async () => {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;

  let controller: SessionSettingIntentController<boolean> | undefined;
  const render = async (catalogRevision: number, catalogValue: boolean) => {
    await act(async () => {
      root.render(createElement(Harness, {
        catalogRevision,
        catalogValue,
        capture: (next) => {
          controller = next;
        },
      }));
    });
  };

  await render(0, false);
  await act(async () => {
    await controller?.request('session-1', true);
  });
  assert.equal(container.querySelector('output')?.getAttribute('data-value'), 'true');

  // Runtime automatically leaves Plan after approval. This is a successful,
  // causally newer catalog observation, so its Agent value must win even
  // though it differs from the renderer's earlier committed Plan value.
  await render(1, false);

  assert.equal(container.querySelector('output')?.getAttribute('data-value'), 'false');
});

test('awaitSettled waits for an in-flight mode commit', async () => {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;
  let releaseWrite!: () => void;
  let controller: SessionSettingIntentController<boolean> | undefined;
  await act(async () => {
    root.render(createElement(Harness, {
      catalogRevision: 0,
      catalogValue: false,
      capture: (next) => { controller = next; },
      write: () => new Promise<boolean>((resolve) => { releaseWrite = () => resolve(true); }),
    }));
  });
  const request = controller!.request('session-1', true);
  let settled = false;
  const waiting = controller!.awaitSettled('session-1').then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  releaseWrite();
  await request;
  await waiting;
  assert.equal(settled, true);
});

function Harness({
  catalogRevision,
  catalogValue,
  capture,
  write = async () => true,
}: {
  catalogRevision: number;
  catalogValue: boolean;
  capture(controller: SessionSettingIntentController<boolean>): void;
  write?: () => Promise<boolean>;
}) {
  const controller = useSessionSettingIntent<boolean>({
    catalogRevision,
    write,
    refreshCatalog: async () => {
      throw new Error('catalog unavailable');
    },
    onWriteError: () => {},
  });
  capture(controller);
  return createElement('output', {
    'data-value': (controller.overlayBySession['session-1'] ?? catalogValue).toString(),
  });
}
