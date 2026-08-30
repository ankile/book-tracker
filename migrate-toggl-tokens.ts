// SEC-004: move each Toggl credential out of users/{uid}.toggl — readable
// by its owner and mirrored into every device's IndexedDB — into the
// `secrets` Firestore database (togglTokens/{uid}), leaving the
// status-only mirror {workspaceId, projectId, connectedAt} behind.
// Idempotent: an already-migrated account prints `ok` and is untouched.
//
// --rotate (requires --apply) asks Toggl for a fresh token first
// (POST /api/v9/me/reset_token, authenticated with the stored token) and
// stores the replacement, so the copies cached on devices stop working at
// Toggl too. If Toggl refuses token-authenticated rotation the script
// says so and stores the existing token — the owner then rotates in the
// Toggl profile UI and re-saves on the Me page.
//
// This script never prints a token; only lengths.
//
//   node migrate-toggl-tokens.ts                    # emulator dry-run
//   node migrate-toggl-tokens.ts --apply            # emulator apply
//   node migrate-toggl-tokens.ts --prod             # prod dry-run
//   node migrate-toggl-tokens.ts --prod --apply [--rotate]
import { getApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { parseFlags, connect } from './migrate-lib.ts';

const argv = process.argv.slice(2);
const rotateFlag = argv.includes('--rotate');
const flags = parseFlags(argv.filter((arg) => arg !== '--rotate'));
if (rotateFlag && !flags.apply) throw new Error('--rotate changes the credential at Toggl; it needs --apply');
const { db } = await connect({ ...flags, confirmWrite: flags.apply });
const secretsDb = getFirestore(getApp(), 'secrets');
const tag = flags.apply ? 'MIGRATE' : 'DRY';

const isStatus = (toggl: Record<string, unknown>): boolean =>
  Object.keys(toggl).sort().join(',') === 'connectedAt,projectId,workspaceId' &&
  toggl.connectedAt instanceof Timestamp;

async function rotate(token: string): Promise<string> {
  const resp = await fetch('https://api.track.toggl.com/api/v9/me/reset_token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${token}:api_token`).toString('base64'),
      'Content-Type': 'application/json',
    },
  });
  if (!resp.ok) {
    console.log(`  rotation refused by Toggl (status ${resp.status}) — storing the existing token; rotate in the Toggl profile UI and re-save on the Me page`);
    return token;
  }
  const fresh: unknown = await resp.json();
  if (typeof fresh !== 'string' || fresh.length === 0) throw new Error('reset_token returned a non-string');
  console.log(`  rotated at Toggl (old ${token.length} chars -> new ${fresh.length} chars)`);
  return fresh;
}

let migrated = 0;
let already = 0;
const users = await db.collection('users').get();
for (const user of users.docs) {
  const toggl = user.get('toggl') as Record<string, unknown> | undefined;
  if (toggl === undefined) continue;
  if (isStatus(toggl)) {
    already += 1;
    console.log(`ok ${user.ref.path} already migrated`);
    continue;
  }
  // Anything that is not the exact legacy shape is drift this script must
  // not guess about.
  if (Object.keys(toggl).sort().join(',') !== 'apiToken,projectId,workspaceId') {
    throw new Error(`${user.ref.path}.toggl has unexpected keys [${Object.keys(toggl).sort().join(',')}]`);
  }
  const apiToken = toggl.apiToken;
  const workspaceId = toggl.workspaceId;
  const projectId = toggl.projectId;
  if (typeof apiToken !== 'string' || apiToken.length === 0) throw new Error(`${user.ref.path}.toggl.apiToken is not a non-empty string`);
  if (!Number.isInteger(workspaceId) || (workspaceId as number) <= 0) throw new Error(`${user.ref.path}.toggl.workspaceId is not a positive int`);
  if (!Number.isInteger(projectId) || (projectId as number) <= 0) throw new Error(`${user.ref.path}.toggl.projectId is not a positive int`);
  const tokenRef = secretsDb.collection('togglTokens').doc(user.id);
  console.log(`${tag} ${user.ref.path}.toggl (token ${apiToken.length} chars, workspace ${String(workspaceId)}, project ${String(projectId)}) -> secrets:${tokenRef.path}`);
  if (flags.apply) {
    const stored = rotateFlag ? await rotate(apiToken) : apiToken;
    // Credential first, mirror second — same order as toggl-savetoken.
    await tokenRef.set({ apiToken: stored, workspaceId, projectId, updatedAt: FieldValue.serverTimestamp() });
    await user.ref.update({ toggl: { workspaceId, projectId, connectedAt: FieldValue.serverTimestamp() } });
  }
  migrated += 1;
}
console.log(`${migrated} credential${migrated === 1 ? '' : 's'} ${flags.apply ? 'migrated' : 'to migrate (dry run, nothing written)'}, ${already} already migrated, ${users.size} users scanned`);
