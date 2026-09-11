import { cachedReadable } from '../../src/lib/stores/cached-readable.ts';

export const starts = new Map<string, number>();
export const stops = new Map<string, number>();
export const codeRoutes: string[] = [];
export const ADMIN_UID = 'test-operator';

const stores = new Map<string, ReturnType<typeof cachedReadable<string[]>>>();
export function storeFor(label: string) {
  let store = stores.get(label);
  if (!store) {
    store = cachedReadable<string[]>(['retained result'], () => {
      starts.set(label, (starts.get(label) ?? 0) + 1);
      return () => stops.set(label, (stops.get(label) ?? 0) + 1);
    });
    stores.set(label, store);
  }
  return store;
}

export const Database = {
  getAllBooks: (uid: string) => storeFor(`books:${uid}`),
  getAuthors: () => storeFor('authors'),
  getUser: (uid: string) => storeFor(`user:${uid}`),
  getMyProfile: (uid: string) => storeFor(`profile:${uid}`),
  getAllReadingSessions: (uid: string) => storeFor(`history:${uid}`),
};
export const adminCatalogScan = storeFor('admin');
export const adminOverview = async () => ({ data: {} });
export const preloadCode = async (route: string) => { codeRoutes.push(route); };
