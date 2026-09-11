import {summarizeListenPayload} from './listenSummary.ts';
export type ListenSummary = ReturnType<typeof summarizeListenPayload>;

// WebChannel lengths count responseText UTF-16 units, not UTF-8 bytes.
export function createListenStreamDecoder(limit = 2_000_000) {
  const utf8 = new TextDecoder();
  let buffer = '';
  let closed = false;
  let framed: boolean | undefined;
  function fail(oversized: boolean): ListenSummary[] {
    closed = true;
    buffer = '';
    return [{...summarizeListenPayload('[]'), [oversized ? 'oversized' : 'malformed']: 1}];
  }
  return {
    get bufferedBytes() {return buffer.length * 2;},
    feed(bytes: Uint8Array): ListenSummary[] {
      if (closed) return [];
      if (buffer.length * 2 + bytes.byteLength * 2 > limit) return fail(true);
      buffer += utf8.decode(bytes, {stream:true});
      if (buffer.length > 0 && framed === undefined) framed = /^\d/.test(buffer);
      const summaries: ListenSummary[] = [];
      while (framed && buffer.length > 0) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) {
          if (buffer.length > 12) return fail(false);
          break;
        }
        if (!/^\d+$/.test(buffer.slice(0, newline))) return fail(false);
        const length = Number(buffer.slice(0, newline));
        if (!Number.isSafeInteger(length) || length < 1) return fail(false);
        if (length * 2 > limit) return fail(true);
        if (buffer.length - newline - 1 < length) break;
        summaries.push(summarizeListenPayload(buffer.slice(newline + 1, newline + 1 + length)));
        buffer = buffer.slice(newline + 1 + length);
      }
      return summaries;
    },
    finish(): ListenSummary[] {
      if (closed) return [];
      closed = true;
      buffer += utf8.decode();
      const result = buffer.length === 0 ? [] : [summarizeListenPayload(buffer)];
      buffer = '';
      return result;
    },
    discard() {closed = true; buffer = '';},
  };
}

// Data events may arrive before streamResourceContent's bufferedData reply.
// Queue them until that initial prefix has been consumed, without duplicating it.
export function createListenStreams(emit: (summary: ListenSummary) => void, limit = 4_000_000, streamLimit = 2_000_000) {
  const streams = new Map<string, {decoder: ReturnType<typeof createListenStreamDecoder>; ready: boolean; queued: Uint8Array[]; queuedBytes: number; ended: boolean}>();
  let dropped = 0;
  function bytes() {return [...streams.values()].reduce((total, stream) => total + stream.decoder.bufferedBytes + stream.queuedBytes, 0);}
  function discard(id: string) {streams.get(id)?.decoder.discard(); streams.delete(id); dropped++;}
  function feed(id: string, chunk: Uint8Array, initial = false) {
    const stream = streams.get(id);
    if (!stream) return;
    // Conservative UTF-16 expansion allowance. Queue storage itself is bytes.
    if (bytes() + chunk.byteLength * 2 > limit || stream.decoder.bufferedBytes + stream.queuedBytes + chunk.byteLength * 2 > streamLimit) {discard(id); return;}
    if (!stream.ready && !initial) {
      if (stream.queued.length >= 1024) {discard(id); return;}
      stream.queued.push(chunk); stream.queuedBytes += chunk.byteLength; return;}
    for (const summary of stream.decoder.feed(chunk)) emit(summary);
  }
  return {
    open(id: string) {
      if (streams.size >= 32) {dropped++; return false;}
      streams.set(id, {decoder:createListenStreamDecoder(streamLimit), ready:false, queued:[], queuedBytes:0, ended:false});
      return true;
    },
    feed,
    ready(id: string, buffered: Uint8Array) {
      const stream = streams.get(id);
      if (!stream) return;
      feed(id, buffered, true);
      stream.ready = true;
      for (const chunk of stream.queued) {stream.queuedBytes -= chunk.byteLength; feed(id, chunk);}
      stream.queued.length = 0;
      if (stream.ended) this.finish(id);
    },
    finish(id: string) {
      const stream = streams.get(id);
      if (!stream) return;
      if (!stream.ready) {stream.ended = true; return;}
      for (const summary of stream.decoder.finish()) emit(summary);
      streams.delete(id);
    },
    discard,
    get bufferedBytes() {return bytes();},
    get dropped() {return dropped;},
    get active() {return streams.size;},
    clear() {for (const stream of streams.values()) stream.decoder.discard(); streams.clear();},
  };
}
