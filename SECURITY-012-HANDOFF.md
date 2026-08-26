# SEC-012 hardening handoff

Last updated: 2026-08-26

## Current state

SEC-012 is not closed. No SEC-012 commit has been pushed to `origin/master`, no
production deployment has been performed from this work, no service-account key
has been deleted, and the security-review item has not been struck.

The work now lives on branch `security/sec-012-hardening` in this worktree:

```text
/Users/larsankile/code/book-tracker-sec012-hardening
```

The branch is based on `origin/master` at `9e9ec28` and contains nine committed
SEC-012 changes through `3596ab6`. Two files also contain uncommitted remediation
from the second red-team review:

```text
deployment-integrity.ts
tests/deployment-integrity.test.ts
```

The original checkout's untracked `ideas/` directory belongs to the user. It was
not copied, stashed, modified, or added to this branch.

## What SEC-012 is

The original deployment process could prove that the repository was reviewed,
but it did not prove that the bytes and configuration running in Firebase and
Google Cloud were the reviewed release. Mutable release labels, Hosting state,
Cloud Functions source objects, Cloud Run images, IAM, and related resources
could drift after review.

The work attempts to make release verification fail unless one reviewed commit
matches the effective production deployment. This includes executable bytes,
runtime configuration, resource inventory, access policy, and deployment
provenance.

This is a real issue. The red-team reviews found working ways to make an earlier
verifier approve unreviewed executable content. Holding the deployment was the
right call.

## What has improved

The branch adds a deployment target and verifier that cover much more of the
production system than `origin/master`:

- Hosting files are hashed from the active Firebase Hosting version, not trusted
  from CDN responses alone.
- Functions artifacts and the generated public-profile probe are bound to
  reviewed manifests.
- Gen 1 source archives and Gen 2 versioned Storage source objects are downloaded
  and hashed.
- Gen 2 Cloud Build resources, managed build steps, environment, builder images,
  source generation, administrative audit records, and build timing are checked.
- Cloud Run service and immutable revision configuration are normalized and
  compared. Startup commands, environment, secrets, volumes, annotations,
  scaling, traffic, URLs, SSH state, base-image updates, and build configuration
  are covered.
- OCI manifests, configurations, layers, whiteouts, hardlinks, symlinks, file
  metadata, effective executable files, archived build input, and image execution
  configuration are inspected.
- Cloud Run Services, Jobs, and WorkerPools are inventoried. The verifier combines
  direct regional reads with Cloud Asset results and fails on denied regions that
  lack a location-policy proof.
- Firestore and Storage rules, indexes, TTLs, Auth configuration and providers,
  IAM ancestry, custom roles, service accounts and keys, Secret Manager,
  Artifact Registry, Storage buckets and ACLs, Eventarc, and Pub/Sub are
  inventoried.
- Mutable IAM principals and unreviewed user-managed service-account keys block a
  release.
- Git origin, remote state, replacement refs, grafts, URL rewrites, ignored
  dotenv/secret inputs, and local exclude configuration are checked.
- Capture writes only runtime attestations and the Run inventory checkpoint. The
  follow-up commit must be a target-only child of the deployment commit.

This is materially stronger than `origin/master`. It is not yet strong enough to
ship.

## Commit history

The SEC-012 series is linear on top of `origin/master`:

```text
7242da8 Add production deployment integrity gate
f573d5f Harden production deployment integrity verification
1b91f8e Bind deployments to immutable production artifacts
83186d4 Close production surface integrity gaps
aeee880 Close deployment integrity review gaps
29c0205 Bind deployment verification to authoritative provenance
f904145 Attest effective Cloud Run deployments
2cc4951 Close deployment verifier bypasses
3596ab6 Harden deployment attestation closure
```

The aggregate committed change from `origin/master` is about 9,000 added lines
across 26 files. Most of that is the verifier, target manifest, and exploit tests.

## Validation completed before the second review

Commit `3596ab6` passed `npm run validate`. That run included:

- Svelte and TypeScript checks with zero errors or warnings
- unit tests
- Firebase Auth, Firestore, and Storage emulator tests using dummy data
- mocked Toggl, Google Books, Nasjonalbiblioteket, Goodreads, Cloud Functions,
  Cloud Run, Cloud Build, Logging, Artifact Registry, Cloud Asset, IAM, Auth,
  Eventarc, Pub/Sub, Storage, and Rules API behavior
- 57 Firebase rules/emulator tests in that run
- 73 Functions tests
- production app and Functions builds
- deploy-artifact and bundle-budget tests
- `npm audit --omit=dev`
- `npm --prefix functions audit`
- zero reported dependency vulnerabilities

That green run proved the candidate was internally consistent. It did not prove
the security design was complete. The second red-team review found bypasses that
the tests did not model.

## Production observations

All production work so far was read-only.

- The project is `book-tracker-d8f24`, project number `440931185227`, in
  `europe-west1` for the reviewed functions.
- Production currently has the three expected Function-backed Run services:
  `publicweb`, `toggl-syncqueue`, and `deletebookupdates`.
- Exact regional Cloud Run enumeration covered 43 regions. `me-central2` returned
  a location-policy `403`.
- Direct Cloud Asset API requests returned the three services and no Run Jobs or
  WorkerPools. The release runbook still needs an explicit API enable/preflight
  step because service enablement reporting was inconsistent with the successful
  direct API call.
- Current Cloud Run service responses contain `urls`, `sshEnabled`, and
  `buildConfig`. Earlier mocks omitted them. These fields are now pinned.
- `buildConfig.enableAutomaticUpdates` is true on the managed service. A
  Google-initiated base-image rebuild will invalidate an existing runtime
  attestation. The runbook still needs a clear re-attestation procedure for that
  event.
- The current `publicweb` managed build omits the optional
  `X_GOOGLE_FASTER_LANGUAGE_TARBALL_INSTALLATION` pre-build variable. The other
  two builds include it. The verifier now permits exactly that optional omission.
- Cloud Build writes two Admin Activity `CreateBuild` records for one build. They
  are the `first` and `last` records for the same operation. The Logging API also
  needs an explicit timestamp filter to retrieve older records. The verifier now
  checks that exact lifecycle.
- The old `deletebookupdates` immutable image manifest returns `404` from the
  Docker Registry API. It appears to have been garbage-collected. A fresh deploy
  is required before final runtime attestation can succeed.
- Container Analysis is disabled. Managed Firebase builds also do not declare an
  output image in Cloud Build's `images` field, so the Cloud Build resource does
  not expose the required output digest directly.
- Cloud Build output logs contain the authoritative output image digest, but
  those logs have short retention. Admin Activity logs last longer but do not
  bind the build to its output digest.
- Two user-managed service-account keys remain in production, one associated
  with the Firebase Admin SDK account and one with the Vision API account. They
  were deliberately not removed before a reviewed, compatible rollout exists.

## First red-team review

The first exact-candidate review covered commit `2cc4951`.

Codex found:

1. A high-severity audit race. The Run mutation audit could finish while other
   inventories were still running, leaving a create/execute/delete window.
2. A high-severity production incompatibility. Current Run fields were missing
   from the allowlist and execution-relevant `buildConfig` state was not pinned.
3. A Cloud Asset rollout dependency that lacked an enablement and preflight step.

Claude found:

1. The output digest depended on a short-retention Cloud Build log.
2. OCI symlink directory aliases could misrepresent the effective filesystem.
3. The same audit race.
4. Template-level `baseImageUri` was dropped.
5. Git excludes, proxy configuration, and an ignored runtime ZIP dependency could
   affect the verifier.
6. Missing exploit regressions for some of those cases.

Changes in `3596ab6` addressed those findings by moving the audit after live
reads, adding a settled delay, pinning current Run fields, checking base-image
state, removing the verifier's runtime ZIP-library dependency, adding a strict
ZIP parser, checking symlink aliases, broadening Git configuration checks, and
updating the runbook.

## Second red-team review

The second review covered exact commit
`3596ab6e861f67a2df86d67853c96133684b911f`.

Both reviewers said the commit was not clean.

### High-severity findings

1. **Initial capture could approve an arbitrary executable image.** Build ID and
   source labels came from the image itself. Artifact Registry timestamps did not
   prove that Cloud Build produced that digest. Capture could serialize a
   malicious layer or entrypoint as the first trusted attestation.

2. **A write through a symlink could disappear from the flattened OCI model.** An
   image could create `/app -> /workspace`, write through `/app` in a later layer,
   then replace `/app` with a directory. The final alias check would miss the
   materialized write.

3. **Git working-tree checks could be spoofed.** `assume-unchanged`,
   `skip-worktree`, `core.fsmonitor`, `core.worktree`, and local attributes/clean
   filters could hide edits to the verifier that executes from the working tree.

### Medium-severity findings

4. **The ZIP parser could disagree with a real extractor.** A fake EOCD and
   central directory inside the real ZIP comment could select different files.
   Local CRC/size fields and unsupported extra fields were not fully checked.

5. **The final mutation check covered only Cloud Run.** Rules, IAM, Auth, Hosting,
   Functions, or another inventoried resource could change after its read.

6. **Cloud Asset convergence remained an assumption in denied regions.** A
   pre-checkpoint resource that had not reached Cloud Asset could be absent from
   both available inventory paths.

### Lower-severity and operational findings

- The inventory checkpoint had no upper age bound relative to audit retention.
- Documentation claimed a wider mutation interval than the timestamp filter
  actually checked.
- Gzip expansion was not bounded in two paths.
- A valueless Git config key was parsed incorrectly.
- Automatic base-image updates lacked a recovery runbook.
- Mocks did not exercise the real Git index flags, Cloud Asset name shape, API
  disablement, or post-cutoff behavior.

The reviewers disagreed on two details:

- Claude described Cloud Asset as disabled, while direct authenticated API reads
  succeeded and returned the expected resources. This needs a clean rollout
  preflight, not an assumption either way.
- Claude considered the existing capture-mode gating sound. Codex demonstrated
  that the missing build-to-digest binding still made first capture circular.
  The Codex finding is valid and is being fixed.

## Current uncommitted remediation

The worktree contains these changes after `3596ab6`:

### Build output binding

- Initial capture again queries the retained Cloud Build output log for the exact
  `Step #2 - "build"` output digest.
- That digest must equal the immutable digest in the deployed Run revision.
- Capture stores the digest in the target-only runtime attestation.
- Later verification compares the live revision to the reviewed stored digest and
  does not require the short-retention output log.
- New capture tests are being added for a malicious executable layer, an
  overwritten `/workspace` file, and an OCI entrypoint override.

This is the intended answer to the retention problem. The short-lived log is
required only while creating the durable reviewed attestation.

### OCI symlinks and compressed inputs

- Every layer entry now fails if its path traverses a symlink that is effective at
  that point in layer application.
- The exploit regression includes the later replacement of the symlink with a
  directory.
- Gzip expansion now has explicit output limits for image layers and archived
  source.

### ZIP parsing

- The parser requires one EOF-aligned EOCD.
- It rejects ambiguous second EOCD records hidden in comments.
- Central and local flags, methods, CRCs, sizes, paths, extra fields, comments,
  creator type, file type, ranges, and overlaps receive stricter checks.
- A regression constructs a second valid ZIP inside the first ZIP's comment.

### Git state

- The production runner binds Git to the verifier's absolute repository root and
  Git directory.
- It disables fsmonitor for verifier commands.
- Local worktree, fsmonitor, attributes, and filter settings are rejected.
- Index special flags are read directly.
- The index tree is compared with the reviewed commit.
- Every tracked regular file and symlink is rehashed from disk as a raw Git blob.
- A real temporary-repository regression uses both `assume-unchanged` and
  `skip-worktree` to hide malicious edits.

This still has a basic trust limitation: a verifier started from a writable local
checkout cannot create an absolute proof of its own integrity. A clean CI runner
that checks out the reviewed commit is a better boundary.

### Consistency interval

- The mutation query now covers all project Admin Activity, not only
  `run.googleapis.com`.
- Verification performs two complete normalized observations around a settled
  delay and rejects any difference.
- Capture checkpoints must be at least ten minutes old and no more than one hour
  old.
- A second settled delay precedes the final project-wide audit.
- A delayed non-Run Rules mutation regression is being added.

The exact cutoff semantics and Cloud Asset convergence guarantee still need
review. No finite read-and-audit sequence can prevent a writer from changing
production immediately after the final cutoff. The runbook therefore requires a
real deployment freeze until final verification completes.

## Current test state

The isolated worktree has its own locked dependency install. `npm ci` reported
zero vulnerabilities. The current WIP passes the Node TypeScript check.

The focused documentation and deployment-integrity run completed with 60 passing
tests out of 62. `git diff --check` did not run because the test command stopped
at the failures.

The two failures are important blockers:

1. The new malicious first-capture loop still reached its `stdout` attestation
   callback. The intended build-output digest check is present in the WIP, but at
   least one malicious image fixture still passes capture. This means the primary
   second-review finding is not fixed yet.
2. The production CLI now rejects linked Git worktrees before option parsing.
   That contradicts this branch's isolated-worktree workflow and breaks the
   existing symlinked-path execution test. The Git-directory binding must support
   Git's `.git` pointer file while still verifying the resolved common and
   per-worktree Git directories.

The earlier project-wide mutation-fixture routing failure has been corrected and
now passes. The real temporary-repository regressions for `assume-unchanged` and
`skip-worktree` also pass.

Do not interpret the current worktree as green or deployable. The next work must
first fix the two blockers above, then rerun:

```bash
npm run check:node
node --import ./tests/setup.ts --test tests/deployment-docs.test.ts tests/deployment-integrity.test.ts
git diff --check
```

After the focused suite passes, run:

```bash
npm run validate
```

## What remains before any deployment

1. Finish the exact exploit regressions from the second review.
2. Resolve any failures in the focused suite.
3. Update README and MIGRATIONS for project-wide settled reads, checkpoint age,
   Cloud Build output-log capture, automatic base-image updates, and exact cutoff
   wording.
4. Run the full emulator, Functions, build, artifact, bundle, and audit suite.
5. Commit the WIP on `security/sec-012-hardening`.
6. Send the exact commit independently to Codex and Claude.
7. Fix every actionable finding, rerun validation, recommit, and repeat both
   reviews until each explicitly says the same commit is clean.
8. Only then consider pushing and deploying.

## Rollout plan if the candidate becomes clean

The intended rollout has two reviewed commits because runtime image evidence does
not exist before deployment.

1. Push the clean deployment commit with Gen 2 `runtimeAttestation` values and
   `security.runInventoryCheckpoint` left as `null`.
2. Deploy compatible Functions and Hosting in the documented order.
3. Confirm old and new clients remain compatible.
4. Remove stale resources and the two user-managed service-account keys only when
   their callers have been migrated and OAuth/service identity access is proven.
5. Enable and preflight Cloud Asset with the release account. It must show exactly
   the reviewed Function-backed services and no Jobs or WorkerPools.
6. Freeze all project deployment and configuration writes.
7. Record a fresh checkpoint, wait at least ten minutes, and run capture while the
   Cloud Build output logs still exist.
8. Keep the freeze through both settled observations and the final project-wide
   audit.
9. Merge only the emitted checkpoint and runtime attestations into
   `deployment-target.json`.
10. Commit that target-only change as the single-parent child of the deployment
    commit.
11. Review the attestation commit, push it, and run final production verification.
12. Monitor the seven-day old-client compatibility window before striking SEC-012
    from the security review.

The seven-day window means initial deployment and technical attestation can
finish sooner, but full issue closure cannot honestly be declared until the
compatibility period passes.

## Decision point

The custom verifier is now more than 4,000 lines and models many Google Cloud APIs
and archive/container formats. That has bought real coverage, but it also creates
a new security-sensitive program that must track provider response changes.

Before investing further, choose between these paths:

1. Continue the current verifier and accept its maintenance cost. Finish the
   second-review fixes, require two clean reviews, and keep the release freeze and
   target-only attestation process.
2. Move the release boundary to a clean CI environment. Use a protected branch,
   immutable commit checkout, short-lived workload identity, a dedicated release
   account, environment approval, and retained build attestations. Keep a smaller
   production drift checker instead of trusting a locally executed 4,000-line
   verifier.
3. Combine both approaches. Put the current verifier in clean CI, remove the
   local-Git self-integrity machinery, and rely on CI provenance for the
   build-to-image binding while retaining the valuable production inventory and
   OCI checks.

Option 3 is the strongest practical direction. It preserves the detailed drift
checks while replacing the weakest assumption, a writable local checkout proving
its own integrity.

## Useful commands

```bash
cd /Users/larsankile/code/book-tracker-sec012-hardening
git status --short
git log --oneline origin/master..HEAD
git diff --stat origin/master...HEAD
git diff
```

The original checkout remains at:

```text
/Users/larsankile/code/book-tracker
```

Its local `master` pointer still contains the nine SEC-012 commits. It was not
reset because that would be destructive. The dedicated branch and worktree are
now the canonical place for any further SEC-012 work.
