import {onSnapshot, type Query, type DocumentReference, type DocumentData, type QuerySnapshot, type DocumentSnapshot, type FirestoreError} from 'firebase/firestore';
import {createSubscriptionDiagnostics, instrumentSubscription, type QueryLabel} from './subscriptionDiagnostics.ts';

const capture = createSubscriptionDiagnostics(Date.now, () => ({online: navigator.onLine, visibility: document.visibilityState}));

// Opt-in from this tab's developer console. Nothing is uploaded or persisted.
// The emitted module filename identifies the application build without a URL.
if (typeof window !== 'undefined') {
  const tab = crypto.randomUUID();
  const api = {
    start: () => capture.start(),
    stop: () => capture.stop(),
    clear: () => capture.clear(),
    export: () => ({...capture.export(), tab, origin: location.hostname === 'book.ankile.com' ? 'production' : ['localhost', '127.0.0.1'].includes(location.hostname) ? 'local' : 'other', build: new URL(import.meta.url).pathname.split('/').pop()}),
    download() {
      const url = URL.createObjectURL(new Blob([JSON.stringify(api.export(), null, 2)], {type: 'application/json'}));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'book-tracker-subscriptions.json';
      anchor.click();
      URL.revokeObjectURL(url);
    },
  };
  Object.assign(window, {bookTrackerDiagnostics: api});
}

export function diagnosticSnapshot(label: QueryLabel, source: Query<DocumentData>, next: (snapshot: QuerySnapshot<DocumentData>) => void, error: (error: FirestoreError) => void): () => void;
export function diagnosticSnapshot(label: QueryLabel, source: DocumentReference<DocumentData>, next: (snapshot: DocumentSnapshot<DocumentData>) => void, error: (error: FirestoreError) => void): () => void;
export function diagnosticSnapshot(label: QueryLabel, source: Query<DocumentData> | DocumentReference<DocumentData>, next: ((snapshot: QuerySnapshot<DocumentData>) => void) | ((snapshot: DocumentSnapshot<DocumentData>) => void), error: (error: FirestoreError) => void): () => void {
  const metadata = (snapshot: QuerySnapshot<DocumentData> | DocumentSnapshot<DocumentData>) => ({count: 'size' in snapshot ? snapshot.size : snapshot.exists() ? 1 : 0, fromCache: snapshot.metadata.fromCache, hasPendingWrites: snapshot.metadata.hasPendingWrites});
  // Preserve the application's normal delivery semantics. Metadata on every
  // delivered snapshot is recorded, without opting consumers into extra events.
  return source.type !== 'document'
    ? instrumentSubscription(capture, label, (deliver, fail) => onSnapshot(source, deliver, fail), metadata, next as (snapshot: QuerySnapshot<DocumentData>) => void, error)
    : instrumentSubscription(capture, label, (deliver, fail) => onSnapshot(source, deliver, fail), metadata, next as (snapshot: DocumentSnapshot<DocumentData>) => void, error);
}
