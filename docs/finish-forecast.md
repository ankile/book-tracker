# Finish-date forecasts

On Currently Reading, click **Est left** to open the finish forecast. The
existing number still shows active reading time. The dialog adds a calendar
date, historical range, and recent activity context. The dashboard's On deck
dates use the same function.

## Model

The forecast uses the geometric mean of two rates over the last 14 days:

- Minutes spent on this book per elapsed day, using the shorter observed
  span for a recently started book, with a one-day minimum denominator.
- Minutes spent on all books per day, including days without reading.

Remaining pages are converted to minutes using this book's recorded speed.
As in the speed analytics, sessions shorter than five minutes or faster than
150 pages/hour do not estimate speed. Page corrections update remaining
progress but are not reading time. Only sessions at or before the forecast
instant are used. This is a marginal forecast for a book, not a simultaneous
schedule that assigns every future minute to one of the current books.

At least two occupied 24-hour reading buckets are required. The buckets end
at the forecast instant. Without recent reading, the model withholds a date
and can show the separate scenario of resuming the book's previous pace.
Predictions beyond one year are displayed without a precise date. Forecast
instants use elapsed days; dates are displayed in the browser's local zone.

## Uncertainty

Historical session and weekly checkpoints are replayed using prefix progress
and speed. This includes quiet periods and unfinished books. Recorded rows
edited after a cutoff are omitted from that cutoff. Completed books require
a progress row reaching their page count near the recorded completion date.

The ratio of actual to predicted remaining days gives a historical error
distribution. Unfinished books contribute censored lower bounds. A weighted
Kaplan-Meier estimate gives the 10th and 90th percentiles, with equal total
weight per book and separate groups for more than seven days of inactivity.
The current book never calibrates its own interval. The range is widened by
a factor of three, selected in validation, and includes the point estimate.
At least 12 other books are required. If the upper bound cannot be estimated
within one year, the dialog says so. It does not promise an 80% probability.

Historical replay runs in a Web Worker when the dialog opens and when its
data changes. Closing the dialog terminates the worker and subscriptions.
Neither the forecast nor its calibration writes to Firestore. There is no
new database field, migration, function, external API, or production job.
Cached books and sessions can be used offline.

## Reproduce the experiment

The research runner reads a local snapshot and has no database client. It
compares 19 candidates: the existing projection, per-book windows, lifetime
pace, shared-budget allocation, blended rates, simulation, and conditional
pause-resumption estimates. It uses the same selected predictor as the app.

```bash
node forecast-research.ts <snapshot.json> <account-email> explore snapshots/forecast-research
node forecast-research.ts <snapshot.json> <account-email> final snapshots/forecast-research
```

The validation period is 2024; the holdout begins in 2025. Final evaluation
checks the frozen selection and snapshot hash. The main metric is mean
absolute error in remaining days capped at 90, averaged within each book
before averaging across books. Censored outcomes are scored only after
sufficient follow-up. Reports include uncapped completed-book errors, quiet
and parallel-reading subgroups, interval coverage and width, and paired
book-level uncertainty. The small number of books and shared calendar
conditions limit statistical conclusions. Current page counts are assumed
fixed because complete metadata history is unavailable. Deleted sessions
and prior versions of edited records cannot be reconstructed from a snapshot.

Snapshots, account details, login files, checkpoints, screenshots, and result
reports belong in the ignored `snapshots/` directory, not in Git.

## Local review environment

Take a snapshot with the existing read-only `db-snapshot.ts --prod` tool.
Then start a fresh, dedicated local environment using the single-database
configuration below. It loads the application rules and starts no Functions,
so restoration cannot trigger background work.

```bash
npm exec --yes --package firebase-tools@15.24.0 -- firebase emulators:start --config firebase.forecast.json --only auth,firestore --export-on-exit snapshots/forecast-emulator
```

In another terminal:

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node db-restore.ts <snapshot.json> --apply
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node forecast-local.ts <snapshot.json> <account-email> snapshots/forecast-review
VITE_EMULATOR=1 npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

`forecast-local.ts` verifies every source field except the intentionally
excluded Toggl queue, creates or refreshes an emulator-only login, and writes
the login and verification record privately. It has no production mode.
The restore tool does not remove extra documents, so use a fresh emulator.
For later sessions, add `--import snapshots/forecast-emulator` to startup.
Stop and export this review environment before running the full emulator
test suite. Restart it from the saved export afterwards.

This configuration supports forecast review and local reading-data changes.
Integration actions require the separate normal Functions emulator workflow.
A production build does not enable emulator connections just because
`VITE_EMULATOR` is set. Do not use a production preview build for this local
database review. No hosted preview or production deployment is part of this
workflow.

## Method references

- [Time-series cross-validation](https://otexts.com/fpp3/tscv.html)
- [Distributional forecasts and prediction intervals](https://otexts.com/fpp3/prediction-intervals.html)
- [NIST Kaplan-Meier estimation](https://itl.nist.gov/div898/software/dataplot/refman1/auxillar/kaplan.htm)
