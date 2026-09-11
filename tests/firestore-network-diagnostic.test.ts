import assert from 'node:assert/strict';
import test from 'node:test';
import {summarizeListenPayload} from '../diagnostics/listenSummary.ts';
test('summarizes targets and server resets without document or token contents', () => {
 const raw = JSON.stringify([[1,[{targetChange:{targetChangeType:'RESET',targetIds:[77],resumeToken:'SECRET'}},{documentChange:{document:{name:'PRIVATE',fields:{secret:{stringValue:'PRIVATE'}}},targetIds:[77]}},{filter:{targetId:77,count:200}}]]]);
 const summary = summarizeListenPayload(raw);
 assert.deepEqual(summary, {targetAdds:0,resumedTargets:0,resets:1,existenceFilters:1,documentChanges:1,documentDeletes:0,documentRemoves:0,malformed:0,oversized:0});
 assert.equal(JSON.stringify(summary).includes('PRIVATE'),false);
 const post = new URLSearchParams({'req0___data__': JSON.stringify({addTarget:{targetId:77,resumeToken:'SECRET',query:{secret:'PRIVATE'}}})});
 assert.equal(summarizeListenPayload(post.toString(),true).resumedTargets,1);
 assert.equal(summarizeListenPayload('invalid PRIVATE').malformed,1);
 assert.equal(summarizeListenPayload('x'.repeat(2_000_001)).oversized,1);
});
test('handles length-framed WebChannel responses and rejects incomplete frames', () => {
 const frame = JSON.stringify([[2,[{targetChange:{targetChangeType:'RESET'}}]]]);
 const raw = `${frame.length}\n${frame}${frame.length}\n${frame}`;
 assert.equal(summarizeListenPayload(raw).resets,2);
 assert.equal(summarizeListenPayload('999\nPRIVATE').malformed,1);
});

test('capture recognizes the actual Firestore WebChannel URL, excluding lookalikes', async () => {
 const {isListenRequest} = await import('../diagnostics/listenSummary.ts');
 assert.equal(isListenRequest('https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?VER=8'),true);
 assert.equal(isListenRequest('https://example.com/google.firestore.v1.Firestore/Listen/channel'),false);
});

test('CDP attachment accepts only local endpoints without URL credentials', async () => {
 const {isLocalDiagnosticEndpoint} = await import('../diagnostics/listenSummary.ts');
 assert.equal(isLocalDiagnosticEndpoint('http://127.0.0.1:9222'),true);
 for (const endpoint of ['http://user:FAKE_TEST_SECRET@localhost:bad-port','http://secret@localhost:9222','http://localhost:9222?token=secret','http://localhost:9222#secret','http://example.com:9222','file://localhost/foo']) {
   assert.equal(isLocalDiagnosticEndpoint(endpoint),false);
 }
});

test('malformed credential-bearing CDP endpoints are rejected without parser errors leaking input', async () => {
 const {isLocalDiagnosticEndpoint} = await import('../diagnostics/listenSummary.ts');
 for (const endpoint of ['http://user:FAKE_TEST_SECRET@localhost:bad-port', 'http://[localhost?token=FAKE_TEST_SECRET', 'FAKE_TEST_SECRET']) {
   assert.equal(isLocalDiagnosticEndpoint(endpoint), false);
 }
});

test('stream decoder handles split UTF-8 and frames once, with bounded overflow', async () => {
 const {createListenStreamDecoder} = await import('../diagnostics/listenStream.ts');
 const json = JSON.stringify([[1,[{documentChange:{document:{fields:{text:{stringValue:'秘密📚'}}}}},{targetChange:{targetChangeType:'RESET'}}]]]);
 const bytes = new TextEncoder().encode(`${json.length}\n${json}${json.length}\n${json}`);
 const decoder = createListenStreamDecoder();
 const summaries = [];
 for (const byte of bytes) summaries.push(...decoder.feed(Uint8Array.of(byte)));
 summaries.push(...decoder.finish());
 assert.equal(summaries.reduce((n, item) => n + item.documentChanges, 0), 2);
 assert.equal(summaries.reduce((n, item) => n + item.resets, 0), 2);
 assert.equal(decoder.bufferedBytes, 0);
 assert.deepEqual(decoder.finish(), []);
 const capped = createListenStreamDecoder(20);
 assert.equal(capped.feed(new TextEncoder().encode('999\n' + 'x'.repeat(50)))[0].oversized, 1);
 assert.equal(capped.bufferedBytes, 0);
 assert.deepEqual(capped.feed(bytes), []);
});

test('stream pool orders buffered prefix before early events, counts once and bounds global storage', async () => {
 const {createListenStreams} = await import('../diagnostics/listenStream.ts');
 const events: ReturnType<typeof summarizeListenPayload>[] = [];
 const streams = createListenStreams(summary => events.push(summary));
 const json = JSON.stringify([[1,[{targetChange:{targetChangeType:'RESET'}}]]]);
 const bytes = new TextEncoder().encode(`${json.length}\n${json}`);
 streams.open('one');
 streams.feed('one', bytes.slice(5));
 streams.finish('one'); // completion can precede the streaming command reply
 streams.ready('one', bytes.slice(0,5));
 streams.finish('one');
 assert.equal(events.reduce((n,e)=>n+e.resets,0),1);
 assert.equal(streams.active,0);
 assert.equal(streams.bufferedBytes,0);
 const small = createListenStreams(()=>{}, 100, 100);
 small.open('a'); small.open('b'); small.open('c');
 small.feed('a', new Uint8Array(40));
 small.feed('b', new Uint8Array(40));
 assert.equal(small.dropped,1);
 assert.ok(small.bufferedBytes <= 100);
 small.clear();
 assert.equal(small.bufferedBytes,0);
});
