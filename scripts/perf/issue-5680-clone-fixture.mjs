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
import { cp, readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  adoptStorageRootOnImport,
  resolveRootControlNamespace,
} from '@maka/storage/root-authority';

const root = resolve(import.meta.dirname, '../..');
const source = resolve(process.argv[2]);
const destination = resolve(process.argv[3]);
for (const path of [source, destination]) assert(path.startsWith(join(root, 'artifacts/')));
assert.equal(
  await access(destination).then(
    () => true,
    () => false,
  ),
  false,
  'never overwrite a fixture',
);
const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
const registration = await readFile(manifest.registrationPath, 'utf8').then(JSON.parse, () => null);
if (registration?.pid) {
  let alive = false;
  try {
    process.kill(registration.pid, 0);
    alive = true;
  } catch {}
  assert.equal(alive, false, 'close the source Host before copying SQLite');
}
await cp(source, destination, { recursive: true, mode: constants.COPYFILE_FICLONE });
const cloned = JSON.parse(JSON.stringify(manifest).replaceAll(source, destination));
const marker = JSON.parse(
  await readFile(join(cloned.workspaceRoot, '.maka-storage-root.json'), 'utf8'),
);
await adoptStorageRootOnImport({
  path: cloned.workspaceRoot,
  kind: 'interactive',
  expectedRootId: marker.rootId,
});
// A fixture produced in Linux carries Linux's control namespace. The local
// desktop benchmark must wait for the registration on this machine instead.
cloned.registrationPath = join(resolveRootControlNamespace(), marker.rootId, 'registration.json');
await writeFile(
  join(destination, 'manifest.json'),
  JSON.stringify({ ...cloned, clonedFrom: source }, null, 2),
);
console.log(
  JSON.stringify({
    manifest: join(destination, 'manifest.json'),
    root: dirname(cloned.workspaceRoot),
    totals: cloned.totals,
  }),
);
