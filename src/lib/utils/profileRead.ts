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
  let ownFailure: unknown = null;
  if (mayOwn) {
    const own = await readOwn().catch((error: unknown) => {
      ownFailure = error;
      return null;
    });
    if (own !== null) return own;
  }
  const shared = await readPublic();
  if (shared === null && ownFailure !== null) throw ownFailure;
  return shared;
}

// The projection is fetched by username through two caches; a mismatch
// means a cache handed back someone else's profile and must not render.
export function assertProfileViewFor(view: ProfileView, username: string): ProfileView {
  if (view.username !== username) {
    throw new Error(`Requested profiles/${username}.json but received ${view.username}.`);
  }
  return view;
}
