// The capture process handles payloads transiently; only these counters escape.
export function summarizeListenPayload(raw: string, form = false) {
  const totals = {targetAdds:0,resumedTargets:0,resets:0,existenceFilters:0,documentChanges:0,documentDeletes:0,documentRemoves:0,malformed:0,oversized:0};
  if (raw.length > 2_000_000) {totals.oversized++; return totals;}
  function visit(value: unknown, depth = 0) {
    if (depth > 20) return;
    if (Array.isArray(value)) {for (const item of value) visit(item, depth + 1); return;}
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.addTarget && typeof record.addTarget === 'object') {
      totals.targetAdds++;
      const target = record.addTarget as Record<string, unknown>;
      if (typeof target.resumeToken === 'string' && target.resumeToken.length > 0 || target.readTime) totals.resumedTargets++;
    }
    if (record.targetChange && typeof record.targetChange === 'object' && (record.targetChange as Record<string, unknown>).targetChangeType === 'RESET') totals.resets++;
    if (record.filter) totals.existenceFilters++;
    if (record.documentChange) totals.documentChanges++;
    if (record.documentDelete) totals.documentDeletes++;
    if (record.documentRemove) totals.documentRemoves++;
    // Never traverse document fields or query contents.
  }
  function parse(text: string) {
    // Network frames can be incomplete. Do not expose JSON parser errors,
    // which can include document contents from the rejected payload.
    try {visit(JSON.parse(text));} catch {totals.malformed++;}
  }
  if (form) {
    for (const [key, value] of new URLSearchParams(raw)) if (/^req\d+___data__$/.test(key)) parse(value);
  } else if (/^\d+\n/.test(raw)) {
    let remaining = raw;
    while (remaining.length > 0) {
      const newline = remaining.indexOf('\n');
      if (newline < 1 || !/^\d+$/.test(remaining.slice(0, newline))) {totals.malformed++; break;}
      const length = Number(remaining.slice(0, newline));
      remaining = remaining.slice(newline + 1);
      if (!Number.isSafeInteger(length) || length < 1 || length > remaining.length) {totals.malformed++; break;}
      parse(remaining.slice(0, length));
      remaining = remaining.slice(length);
    }
  } else parse(raw);
  return totals;
}

export function isListenRequest(value: string): boolean {
  const url = new URL(value);
  return url.hostname === 'firestore.googleapis.com' && url.pathname === '/google.firestore.v1.Firestore/Listen/channel';
}

export function isLocalDiagnosticEndpoint(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
    && !url.username && !url.password && !url.search && !url.hash;
}
