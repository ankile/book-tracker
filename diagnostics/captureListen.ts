import {chromium} from '@playwright/test';
import {createListenStreams} from './listenStream.ts';
import {writeFile} from 'node:fs/promises';
import {summarizeListenPayload, isListenRequest, isLocalDiagnosticEndpoint} from './listenSummary.ts';

// Explicit local CDP attachment, no browser launch, authentication or navigation.
const [endpoint, origin, output] = process.argv.slice(2);
if (!endpoint || !origin || !output) throw new Error('Usage: node diagnostics/captureListen.ts http://127.0.0.1:9222 https://book.ankile.com output.json');
if (!isLocalDiagnosticEndpoint(endpoint)) throw new Error('CDP endpoint must be localhost without credentials, query parameters or fragments');
if (!['https://book.ankile.com', 'http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin)) throw new Error('Unsupported application origin');
const browser = await chromium.connectOverCDP(endpoint).catch(() => {throw new Error('Could not connect to the local CDP endpoint');});
const pages = browser.contexts().flatMap(context => context.pages()).filter(page => new URL(page.url()).origin === origin);
if (pages.length !== 1) {await browser.close(); throw new Error('Keep exactly one matching application tab open for capture');}
const session = await pages[0].context().newCDPSession(pages[0]);
const rows: Array<{at: number; direction: string; summary: ReturnType<typeof summarizeListenPayload>}> = [];
const requests = new Set<string>();
const pending = new Set<Promise<void>>();
let active = true;
let dropped = 0;
const startedAt = Date.now();
let streamFailures = 0;
function addSummary(direction: string, summary: ReturnType<typeof summarizeListenPayload>) {
  if (!active) return;
  if (rows.length >= 500) {dropped++; return;}
  rows.push({at:Date.now(), direction, summary});
}
const streams = createListenStreams(summary => addSummary('response', summary));
session.on('Network.requestWillBeSent', event => {
  if (!isListenRequest(event.request.url)) return;
  if (requests.size >= 500) {dropped++; return;}
  requests.add(event.requestId);
  if (event.request.postData) addSummary('request', summarizeListenPayload(event.request.postData, true));
});
session.on('Network.responseReceived', event => {
  if (!active || !requests.has(event.requestId)) return;
  if (pending.size >= 32) {streamFailures++; return;}
  if (!streams.open(event.requestId)) return;
  // bufferedData is the prefix received before streaming became active.
  // Subsequent dataReceived.data chunks follow it, possibly before this reply.
  const operation = session.send('Network.streamResourceContent', {requestId:event.requestId}).then(result => {
    if (!active) return;
    if (result.bufferedData.length > 2_666_672) {streams.discard(event.requestId); return;}
    streams.ready(event.requestId, Buffer.from(result.bufferedData, 'base64'));
  }).catch(() => {
    streams.discard(event.requestId);
    streamFailures++;
  });
  pending.add(operation);
  void operation.finally(() => pending.delete(operation));
});
session.on('Network.dataReceived', event => {
  if (!active || !event.data || !requests.has(event.requestId)) return;
  if (event.data.length > 2_666_672) {streams.discard(event.requestId); return;}
  streams.feed(event.requestId, Buffer.from(event.data, 'base64'));
});
session.on('Network.loadingFinished', event => {
  if (requests.delete(event.requestId) && active) streams.finish(event.requestId);
});
session.on('Network.loadingFailed', event => {
  if (requests.delete(event.requestId)) {streams.discard(event.requestId); dropped++;}
});
await session.send('Network.enable', {maxTotalBufferSize: 4_000_000, maxResourceBufferSize: 2_000_000, maxPostDataSize: 2_000_000});
console.log('Capturing metadata for 60 seconds. No raw payloads are saved.');
await new Promise(resolve => setTimeout(resolve, 60_000));
active = false;
const incompleteRequests = requests.size;
const incompleteStreams = streams.active;
const droppedStreams = streams.dropped;
streams.clear();
await session.detach();
await Promise.allSettled(pending);
await browser.close();
await writeFile(output, JSON.stringify({version:1, startedAt, endedAt:Date.now(), origin:origin.includes('book.ankile.com')?'production':'local', dropped, droppedStreams, streamFailures, incompleteRequests, incompleteStreams, rows}, null, 2), {flag:'wx', mode:0o600});
if (streamFailures > 0) console.log('Some streams could not be inspected. Capture is incomplete; upgrade Chromium if streaming CDP is unavailable.');
console.log('Saved metadata capture. Snapshot and wire document counts are not billed-read counts.');
