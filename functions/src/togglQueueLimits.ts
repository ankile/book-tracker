// Bounds on the per-user Toggl sync queue. Kept out of toggl.ts so tests can
// pin them without the module's export inventory changing, and so the rules
// literals that mirror them have one source to be compared against.
//
// TOGGL_QUEUE_LIMIT meters remote Toggl calls: the syncqueue claim
// transaction moves users/{uid}/functionQuotas/togglQueue and, once the
// window is full, defers further rows until the window ends.
//
// TOGGL_QUEUE_ROW_LIMIT bounds how many queue rows one account can mint per
// window (SEC-002). Rules only permit the atomic offline-stop row, which is
// coupled to a real timer clear — but a client can start and stop timers as
// fast as it likes, so without this counter one account yields unlimited
// rows, Eventarc deliveries and invocations. The trigger counts each row in
// users/{uid}/functionQuotas/togglQueueRows the first time it touches it
// and the rules refuse further atomic creates once the window is full. The
// count lags the writes by one Eventarc delivery, so a burst can overshoot
// the limit by whatever lands before the trigger catches up; it cannot
// sustain. An honest user is nowhere near sixty timer stops an hour, and a
// refused stop leaves the timer running rather than losing the interval.
// TOGGL_QUEUE_MAX_DEFERRALS caps how many consecutive windows a pending
// row can be deferred before it becomes terminal; a day over quota means
// the rows were never going to drain, and without the cap each was one
// delivery per window for its whole 90-day retention.
// TOGGL_TOKEN_LIMIT meters savetoken, which makes two outbound Toggl calls
// with a caller-supplied credential (SEC-024).
export const TOGGL_QUEUE_LIMIT = 10;
export const TOGGL_TOKEN_LIMIT = 5;
export const TOGGL_QUEUE_MAX_DEFERRALS = 24;
export const TOGGL_QUEUE_ROW_LIMIT = 60;
export const TOGGL_QUEUE_WINDOW_MS = 60 * 60 * 1000;
export const TOGGL_QUEUE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
