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

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build, Platform, Arch } from 'electron-builder';
import base from '../../apps/desktop/electron-builder.config.mjs';

const root = resolve(import.meta.dirname, '../..');
const preloadPath = resolve(root, 'apps/desktop/dist/preload/preload.cjs');
const original = await readFile(preloadPath, 'utf8');
const marker = 'import_electron4.contextBridge.exposeInMainWorld("maka", makaBridge);';
if (original.split(marker).length !== 2) throw new Error('Preload insertion point changed');
try {
  await writeFile(
    preloadPath,
    original.replace(
      marker,
      `${await readFile(new URL('./issue-5627-preload-probe.cjs', import.meta.url), 'utf8')}\n${marker}`,
    ),
  );
  await build({
    projectDir: resolve(root, 'apps/desktop'),
    targets: Platform.MAC.createTarget('dir', Arch.arm64),
    publish: 'never',
    config: {
      ...base,
      directories: {
        output: resolve(root, process.argv[2] ?? 'artifacts/issue-5627/matched/package'),
      },
      npmRebuild: false,
      // Local measurement bundle; no release signing, notarization or update upload.
      mac: {
        ...base.mac,
        identity: null,
        forceCodeSigning: false,
        notarize: false,
        hardenedRuntime: false,
      },
      // WebSocket is the tested transport. The optional direct-peer native
      // addon is unavailable in this checkout and is not exercised here.
      extraResources: base.extraResources.filter(
        (entry) => !entry.from.endsWith('maka_runtime_host_peer.node'),
      ),
    },
  });
} finally {
  await writeFile(preloadPath, original);
}
