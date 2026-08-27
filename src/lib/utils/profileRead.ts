import type { ProfileView } from '../interfaces/profile.ts';

export type ProfileReader = () => Promise<ProfileView | null>;

// The /profiles/<username> page's read order. A signed-in viewer asks
// Firestore first, which succeeds only for their own profile (public or
// private) and gives the owner a fresh copy; anyone else — anonymous, or a
// signed-in stranger whose own read was denied — gets the publicweb JSON
// projection. Kept free of Firebase so the branching is unit-testable.
export async function resolveProfileView(
  signedIn: boolean,
  readOwn: ProfileReader,
  readPublic: ProfileReader,
): Promise<ProfileView | null> {
  if (signedIn) {
    const own = await readOwn();
    if (own !== null) return own;
  }
  return readPublic();
}
