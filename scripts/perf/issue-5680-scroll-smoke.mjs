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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';
import { catalogJobs, smokeStory, startStaticServer } from '../storybook-visual-smoke.mjs';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, process.argv[2] ?? 'artifacts/issue-5680/scroll-correctness');
await mkdir(output, { recursive: true });
const directory = join(root, 'apps/desktop/storybook-static');
const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'));
const wanted = [
  'history-at-the-top-still-lands-above-the-reader',
  'prepended-history-keeps-measured-heights',
  'nested-scroller-near-history-boundary-asks-for-nothing',
  'filter-work-history-pages',
  'reader-scrolled-up-is-not-pulled-back',
  'dock-affordance-returns-to-tail',
  'virtual-history-continuity',
];
const jobs = catalogJobs(index).filter((job) =>
  wanted.some((name) => job.storyId.endsWith(`--${name}`)),
);
assert.equal(new Set(jobs.map((job) => job.storyId)).size, wanted.length);
const server = await startStaticServer(directory);
const browser = await chromium.launch();
const results = [];
try {
  for (const job of jobs) {
    const page = await browser.newPage();
    try {
      await smokeStory(page, server.baseUrl, job);
      results.push({ ...job, ok: true });
      console.log(`PASS ${job.storyId}`);
    } catch (error) {
      results.push({ ...job, ok: false, error: String(error) });
      console.log(`FAIL ${job.storyId}: ${error}`);
    }
    await page.screenshot({ path: join(output, `${job.storyId}.png`) });
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
  await writeFile(join(output, 'report.json'), JSON.stringify(results, null, 2));
}
assert(
  results.every((result) => result.ok),
  'scroll correctness failed',
);
