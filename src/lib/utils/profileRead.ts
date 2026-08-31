import type { ProfileView } from '../interfaces/profile.ts';

export type ProfileReader = () => Promise<ProfileView | null>;

// The /profiles/<username> page's read order. A viewer who may own the
// profile asks Firestore first, which succeeds only for their own document
// (public or private) and gives the owner a fresh copy; everyone else —
// anonymous, or a signed-in viewer known to own a different username — goes
// straight to the publicweb JSON projection. An own read that fails for any
// reason (denied, offline, a Firestore incident) falls through to the
// projection so a signed-in viewer is never worse off than an anonymous one
// (SEC-092); its error surfaces only if the projection has nothing either.
// Kept free of Firebase so the branching is unit-testable.
export async function resolveProfileView(
  mayOwn: boolean,
  readOwn: ProfileReader,
  readPublic: ProfileReader,
): Promise<ProfileView | null> {
  // Boxed so a rejection whose value happens to be null is still a failure.
  let ownFailure: { error: unknown } | null = null;
  if (mayOwn) {
    const own = await readOwn().then(
      (view) => ({ view }),
      (error: unknown) => ({ error }),
    );
    if ('view' in own) {
      if (own.view !== null) return own.view;
    } else {
      ownFailure = own;
    }
  }
  const shared = await readPublic();
  if (shared === null && ownFailure !== null) throw ownFailure.error;
  return shared;
}

// The /profiles/<username> page's progressive load. The public projection
// needs no auth, so it is fetched first and shown the moment it arrives — a
// refresh never waits for the auth session to restore. Only when the
// projection has nothing (a 404 for a private profile the viewer may own, or
// a projection error) does it fall back to the authenticated owner read, the
// one path that needs auth and that a private profile's owner depends on.
export async function loadProfileProgressively(
  readPublic: ProfileReader,
  readOwnFallback: ProfileReader,
  emit: (view: ProfileView | null) => void,
): Promise<void> {
  const projection = await readPublic().then(
    (view) => ({ view }),
    (error: unknown) => ({ error }),
  );
  if ('view' in projection && projection.view !== null) {
    emit(projection.view);
    return;
  }
  // readOwnFallback is resolveProfileView(): owner read then public retry, so
  // a persistent projection error surfaces instead of a false "not found".
  emit(await readOwnFallback());
}

// The projection is fetched by username through two caches; a mismatch
// means a cache handed back someone else's profile and must not render.
export function assertProfileViewFor(view: ProfileView, username: string): ProfileView {
  if (view.username !== username) {
    throw new Error(`Requested profiles/${username}.json but received ${view.username}.`);
  }
  return view;
}
