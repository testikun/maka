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
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '../../artifacts/issue-5712-edge-costs');
const names = ['root-100','giant-1000','single-output-4m','assistant-4m',
  'root-300','root-1000','branch-100','branch-300','branch-300-reopened','branch-1000','restore-100','restore-1000'];
const round = (v) => Math.round(v * 1000) / 1000;
const ps = (s) => { const [time, rss] = s.trim().split(/\s+/); return {
  cpu: time.split(':').reduce((total, n) => total * 60 + Number(n), 0), rssMiB: Number(rss)/1024,
}; };
const stats = (xs) => {const s=xs.filter(Number.isFinite).sort((a,b)=>a-b);return s.length ? {
  n:s.length,p50:round((s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2),
  min:round(s[0]),max:round(s.at(-1)),
} : null;};
const summary = { productCommit: '5017c7534780f21fef65ab13a93c92c95ce16a3e',
  conditions: 'macOS packaged, local isolated production Host, synthetic settled histories, uncontrolled OS cache, no profiler during timed runs; n=5 descriptive median and maximum', cases: [] };
for (const name of names) {
  const r = await readFile(join(root,name,'report.json'),'utf8').then(JSON.parse,()=>null);
  if(!r)continue;
  const samples = r.samples.idle.map(s=>{
    const {before,after,cycleBefore,observedAfter,memorySamples=[]}=s.resources;
    const first=ps(before.host),last=ps(after.host),observed=ps(observedAfter.host);
    const rendererBefore=before.chromium.processInfo.filter(p=>p.type==='renderer');
    const rendererCpuSeconds=after.chromium.processInfo.filter(p=>p.type==='renderer')
      .reduce((n,p)=>n+p.cpuTime-(rendererBefore.find(q=>q.id===p.id)?.cpuTime??p.cpuTime),0);
    const hostPeakMiB=Math.max(first.rssMiB,last.rssMiB,...memorySamples.flatMap(m=>m.rows.split('\n').flatMap(line=>{
      const [pid,rss]=line.trim().split(/\s+/).map(Number);return pid===r.hostRegistration.pid?[rss/1024]:[];
    })));
    const pages=s.pages??[];
    const readyBatches=(s.transcriptAttempts??[]).flatMap(a=>a.batches).filter(b=>b.ready);
    return {run:s.run,visibleMs:s.fadeCompletePaintMs,readyMs:s.transcript.readyBatchMs,
      finalRangeReadyMs:readyBatches.length ? Math.max(...readyBatches.map(b=>b.at)) : s.transcript.readyBatchMs,
      openMs:s.transcript.openCalledMs,firstBatchMs:s.transcript.firstBatchMs,
      rendererBytes:s.transcript.bytes,batches:s.transcript.batches,historyPages:pages.length,
      pageWaitMs:pages.reduce((n,p)=>n+p.ms,0),hostCpuSeconds:round(last.cpu-first.cpu),
      rendererCpuSeconds:round(rendererCpuSeconds),hostPeakMiB:round(hostPeakMiB),
      postDisplayHostCpuSeconds:round(observed.cpu-last.cpu),resourceWindowMs:after.at-before.at,
      cycleHostCpuSeconds:round(observed.cpu-ps(cycleBefore.host).cpu),
      loadedTurns:s.anchorViewport.loadedTurns,anchorVisible:s.anchorViewport.visible,anchorOffset:s.anchorViewport.offset,
      pageErrors:pages.filter(p=>p.error).length};
  });
  const metrics=Object.fromEntries(['visibleMs','readyMs','finalRangeReadyMs','firstBatchMs','rendererBytes','batches','historyPages','pageWaitMs',
    'hostCpuSeconds','cycleHostCpuSeconds','rendererCpuSeconds','hostPeakMiB','postDisplayHostCpuSeconds','loadedTurns']
    .map(k=>[k,stats(samples.map(s=>s[k]))]));
  summary.cases.push({name,ok:r.ok,error:r.error,shape:r.fixture.target,edge:r.edge,metrics,samples});
}
await writeFile(join(root,'summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary.cases.map(c=>({name:c.name,ok:c.ok,error:c.error,n:c.samples.length,
  visibleMs:c.metrics.visibleMs,readyMs:c.metrics.readyMs,pages:c.metrics.historyPages,
  MiB:c.metrics.rendererBytes?.p50/1048576,cpu:c.metrics.hostCpuSeconds,RSS:c.metrics.hostPeakMiB})),null,2));
