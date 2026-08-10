import { error } from '@sveltejs/kit';
import { auth } from '$lib/firebase/auth.js';

// The operator's immutable auth UID — never the email, which is a
// claimable string while signups are open (see functions/src/admin.ts,
// which enforces the same pair of checks on the server).
const ADMIN_UID = '1Cf0CaNfgnVSvTrF5dYjzRd9Xri2';

// Cosmetic gate at the shared boundary: every admin/* route inherits this
// layout, and non-admins (or signed-out visitors) get the same 404 page an
// unknown route renders. That hides the route from a casual visitor but not
// from anyone who looks — this file ships in the client bundle, UID and all,
// and a static host answers /admin with the same 200 shell as every other
// path. The gate that actually matters is server-side: the admin-overview
// callable verifies the ID token and re-checks UID + email_verified before
// touching any data.
export async function load() {
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user || user.uid !== ADMIN_UID) error(404, 'Not Found');
  // The verified flag was set by the Admin SDK, so a long-lived local
  // session may still hold the stale value; reload fetches the current one.
  await user.reload();
  if (!user.emailVerified) error(404, 'Not Found');
  // Refresh the ID token too: the callable gate checks the email_verified
  // claim inside the token, which can lag the account flag by up to an hour.
  await user.getIdToken(true);
}
