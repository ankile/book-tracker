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

The current model is `blend-14-ungated`. It can estimate from the first
timed reading day, labeled as an early estimate. If this book has no usable
speed, it uses qualifying reading across the library, or 2 minutes per page
until qualifying progress exists. The page states which source is used.
Without recent reading, the model withholds a date
and can show the separate scenario of resuming the book's previous pace.
Predictions beyond one year are displayed without a precise date. Forecast
instants use elapsed days; dates are displayed in the browser's local zone.

## Uncertainty

Historical daily checkpoints at 00:00 UTC are replayed using prefix progress
and speed. This includes quiet periods and unfinished books. Recorded rows
edited after a cutoff are omitted from that cutoff. Completed books require
a progress row reaching their page count near the recorded completion date.

The ratio of actual to predicted remaining days gives a historical error
distribution. Unfinished books contribute censored lower bounds. A weighted
Kaplan-Meier estimate gives the 10th and 90th percentiles, with equal total
weight per book and separate groups for more than seven days of inactivity.
The current book never calibrates its own interval. The range is widened by
a factor of two and includes the point estimate. This factor minimized the
book-weighted nominal 80% interval score among 1, 1.5, 2 and 3 on mature 2024
daily origins, with outcomes censored at January 2025. Bounds and outcomes
are capped at 90 for this scoring, not for the displayed date range.
At least 12 other books are required. If the upper bound cannot be estimated
within one year, the dialog says so. It does not promise an 80% probability.

Historical replay runs in a Web Worker when the dialog opens and when its
data changes. Closing the dialog terminates the worker and subscriptions.
Neither the forecast nor its calibration writes to Firestore. There is no
new database field, migration, function, external API, or production job.
Cached books and sessions can be used offline.

The detail dialog exposes the filtered speed, remaining pages and minutes,
the geometric-mean calculation, and both rates' denominators. Its rolling
14-day activity bars reconcile with the recent budget; daily totals and
session facts are available below the chart. A five-window comparison shows
book-only and blended scenarios, and sliders calculate a specified daily
budget plus a break before resuming. These scenarios never save data or
change the selected forecast.

The uncertainty panel shows the point and bounds separately, the raw
historical error factors, the widening factor, and the calibration sample
and pause group. It labels the range as empirical uncertainty without
claiming a current-book probability. The worker also replays the original
30-day baseline, earlier gated 14-day model and `median-windows` comparison.
It scores all history and the 2025-onward evaluation period with
the research runner's per-book capped-error metric. Every included origin
must have 90 days of follow-up, even if the book finished sooner. The dialog shows
subgroups, date availability within one year, uncapped completed-book
errors, interval coverage and finite-upper frequency, and the largest
completed-book misses. These account-specific results are recomputed from
saved history; no private research result is embedded in the app bundle.
Section shortcuts lead to the date range, calculation, model comparison,
scenarios and accuracy. First-day and borrowed-speed estimates are identified.

## Promotion after daily experiments

The ungated 14-day blend is the default because it had the lowest recent
mean book error among the leading candidates. The multi-window model was
slightly better over the full history and remains visible as a comparison.
The joint simulator did not beat these formulas on later point forecasts;
it remains research-only. These periods have been inspected repeatedly.
This choice is not proof of a universally best model or pristine holdout
performance. Uncertainty factors are recalculated from the new model's
daily predictions; old model residuals are not mixed into its calibration.

The read-only promotion audit checks all 9,298 saved daily cases and four
models, 37,192 comparisons, against the browser's replay, then records range
validation, full-history and recent scores. It requires only local files:

```bash
node forecast-app-audit.ts <snapshot.json> <account-email> snapshots/forecast-daily/predictions.jsonl snapshots/forecast-review/promotion-audit.json
```

The original 19-model runner checks that the app still matches its frozen
selection, so its `final` command intentionally rejects the promoted app.
Use commit `d89b359` to reproduce the original research unchanged, and the
promotion audit above to verify the shipped predictor against saved results.

## Reproduce the experiment

The research runner reads a local snapshot and has no database client. It
compares 19 candidates: the existing projection, per-book windows, lifetime
pace, shared-budget allocation, blended rates, simulation, and conditional
pause-resumption estimates. It records the app's original predictor.

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

Restart the Vite dev server after running production builds or artifact
checks in the same checkout. Those commands regenerate SvelteKit's server
configuration with the production CSP, which excludes the emulator ports.
Hard-refresh an already-open browser tab to replace cached response headers.

## Method references

The subsequent [daily backtesting protocol](forecast-daily-protocol.md)
replays every open book every day, retains cold starts and long holds, and
compares 51 fixed candidates using fixed follow-up cohorts. It includes
commands for the private report and prediction viewer. The app predictor
now uses its ungated 14-day candidate, with the multi-window candidate
available as a comparison.

The [joint simulation experiment](forecast-joint-protocol.md) adds a shared
daily reading budget, competing books, completion and time redistribution,
pauses and returns, and optional synthetic new-book arrivals. It records
development hill climbing, frozen validation selection, empirical CRPS,
matched interval comparisons, and all daily sampled completion times.

- [Time-series cross-validation](https://otexts.com/fpp3/tscv.html)
- [Distributional forecasts and prediction intervals](https://otexts.com/fpp3/prediction-intervals.html)
- [NIST Kaplan-Meier estimation](https://itl.nist.gov/div898/software/dataplot/refman1/auxillar/kaplan.htm)
