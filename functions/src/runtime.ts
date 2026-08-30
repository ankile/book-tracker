// Runtime identities (SEC-022). Each function runs as a dedicated service
// account instead of the project-Editor defaults, so a code-execution bug
// is bounded by the roles below rather than escalating to the project.
// The accounts and their bindings live in IAM (see MIGRATIONS.md,
// 2026-08-27); this file only names them.
//
// publicweb-runtime: roles/datastore.viewer, conditioned by IAM to the
// (default) database only (SEC-097: `resource.name` condition). The one
// function strangers reach can read the default database — Firestore IAM
// has no collection scoping — and nothing else: no writes, no Auth, no
// deploys, and no access to the `secrets` database where the integration
// credentials live (SEC-004), so a renderer compromise cannot reach a
// credential.
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

// Every callable is invokable by anyone (the Firebase SDK checks the ID
// token inside the handler, after the instance has been billed), and the
// Auth triggers fire once per sign-up. Without a cap the only ceiling is
// the region's CPU quota (~500 concurrent gen-1 instances shared by all of
// them), which an anonymous flood can fill at ~$900/day. Real traffic is a
// handful of calls per minute; these caps bound the spend rate and, with
// gen-1 concurrency of 1, also the fan-out any one function can inflict on
// the others. The trade is availability: once the cap is busy, further
// calls queue (gen-1 queues rather than rejecting, and still bills them),
// so an anonymous flood can hold admin-overview's two instances and delay
// the owner's own call. Raise deliberately.
export const CALLABLE_MAX_INSTANCES = 10;
export const ADMIN_MAX_INSTANCES = 2;
export const AUTH_TRIGGER_MAX_INSTANCES = 10;
