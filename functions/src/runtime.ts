// Runtime identities (SEC-022). Each function runs as a dedicated service
// account instead of the project-Editor defaults, so a code-execution bug
// is bounded by the roles below rather than escalating to the project.
// The accounts and their bindings live in IAM (see MIGRATIONS.md,
// 2026-08-27); this file only names them.
//
// publicweb-runtime: roles/datastore.viewer. The one function strangers
// reach can read Firestore — the whole database, Firestore IAM has no
// collection scoping, so that includes users' stored Toggl tokens — and
// nothing else: no writes, no secrets, no Auth, no deploys. Scoping the
// read further means a second Firestore database for public data.
export const PUBLICWEB_RUNTIME_SERVICE_ACCOUNT =
  "publicweb-runtime@book-tracker-d8f24.iam.gserviceaccount.com";

// functions-runtime: roles/datastore.user, roles/firebaseauth.viewer
// (admin overview lists users), roles/eventarc.eventReceiver plus
// run.invoker on the two Eventarc-fed services, and secretAccessor on
// FUNCTIONS_CONFIG_EXPORT (booksapi). Callables and triggers all need
// Firestore writes, so they share one identity.
export const FUNCTIONS_RUNTIME_SERVICE_ACCOUNT =
  "functions-runtime@book-tracker-d8f24.iam.gserviceaccount.com";

// Firestore and Auth events are delivered from Google's network, so the
// two Eventarc-driven gen2 services need no public ingress at all.
export const EVENT_INGRESS = "ALLOW_INTERNAL_ONLY" as const;
