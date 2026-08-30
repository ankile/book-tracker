# Recovery runbook: losing an account, a login, or a credential

This project has no Google Cloud organisation above it. What keeps it
recoverable is three principals, each able to restore the other two:

| Principal | What it is | Where it lives |
|---|---|---|
| Primary Owner | The maintainer's personal Google account | The maintainer's head and 1Password |
| Secondary Owner | A second personal Google account of the maintainer, different provider | 1Password |
| Break-glass service account | `break-glass@…` with the Owner role and exactly one key | The key exists only as a 1Password document. Never on a laptop, never in CI, never in this repository. |

Everything below is done in the Google Cloud console (IAM & Admin) or the
Firebase console unless stated otherwise. Do not paste account names,
project identifiers or key material into this file: the repository is public.

## Decide which case you are in

1. **One human Owner account is lost or locked** (password, 2FA device,
   provider lockout). Use the other Owner. Go to *One Owner lost*.
2. **One human Owner account may be compromised.** Same steps as lost, but
   do them now, and treat everything that account could reach as exposed.
3. **Both human Owner accounts are lost.** Go to *Break-glass*.
4. **Only the Firebase CLI login is stale or revoked.** Go to *CLI login*.
5. **The break-glass key may have leaked.** Go to *Key rotation*.

## One Owner lost

Signed in as the remaining Owner:

1. IAM: remove the Owner binding of the lost account.
2. IAM: grant Owner to a replacement account (a fresh Google account you
   control). Project-level Owner grants outside an organisation are sent as
   an invitation; accept it from the new account's inbox.
3. If the account was compromised rather than lost, also: revoke the
   Firebase CLI's access from that Google account's third-party-access
   page if you still can, rotate any API key the account could read
   (Google Cloud console → APIs & Services → Credentials), and read the
   Cloud Audit Logs for actions taken by that account since the suspected
   date.
4. Update the table above only if the principal *roles* change; names never
   go in here.

## Break-glass

Use a clean machine or a fresh user account on your own. The key must not
end up on a development machine.

1. From 1Password, download the break-glass key document to that machine.
2. Install the Google Cloud CLI. Authenticate the CLI with the key file
   (activate the service account from the key file). Confirm you can read
   the project and its IAM policy.
3. Grant the Owner role to a Google account you control. Accept the
   invitation from that account.
4. Sign in to the Google Cloud console and the Firebase console as that
   account and confirm you can see the project, Firestore, Functions and
   Hosting.
5. Now rotate the break-glass key (next section) — it has been on a machine
   and is no longer "sealed".
6. Delete the key file from the machine, then empty the trash.

## Key rotation

Signed in as an Owner, in IAM & Admin → Service accounts → the break-glass
account → Keys:

1. Create a new JSON key. Save it straight into 1Password as a document,
   replacing the old one. Delete the downloaded file.
2. Delete the old key by its key id.
3. Confirm the account has exactly one key.
4. Note the rotation date on the 1Password item.

Do the same rotation if the key is ever *used* for anything, including the
yearly test.

## CLI login

The Firebase CLI holds a refresh token for the Primary Owner's Google
account. If deploys start failing with credential errors, run
`firebase login --reauth` with the pinned CLI version named in the README.
Plain `login` believes the stale cache and reports "already logged in". If
the grant was revoked from the Google Account page, `--reauth` is the only
way back.

Scripts that read production (`db-audit.ts`, `db-snapshot.ts`, the
`migrate-*.ts` family) authenticate through the maintainer's Google Cloud
CLI login, not through a key. If that login is gone, log the CLI in again
as the Primary Owner; there is no key to restore.

## Yearly test

Once a year (the date is on the 1Password item):

1. On a clean shell, mint an access token from the break-glass key and read
   the project resource with it. A success proves the key, the account and
   its Owner role are all still valid.
2. Rotate the key (above). The test moved the key onto a machine.
3. Confirm both human Owner accounts can still sign in to the Cloud console.

## Things this page deliberately does not cover

- The domain registrar and DNS for the public site: those credentials live
  in 1Password under the registrar's own entry. Losing them does not lose
  the project, only the custom domain, and Hosting keeps serving on the
  default `*.web.app` address.
- Backups and point-in-time recovery: see MIGRATIONS.md.
