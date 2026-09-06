# Reading forecasts: start here

Predict when a book will finish in calendar time, using recorded reading
habits. Open **Est left** on Currently Reading for the date, uncertainty,
supporting facts, comparisons and what-if scenarios. Everything runs locally
in the browser; forecasts do not write data or schedule backend work.

## Current model

**`blend-14-ungated`** divides remaining reading minutes by the geometric
mean of this book's daily reading minutes and the reader's overall daily
minutes over 14 days. Include days without reading; for a newly started book,
divide its minutes by elapsed days since starting, with a one-day minimum.

Remaining minutes use the book's filtered reading speed. When unavailable,
borrow qualifying library speed, then fall back to 2 minutes/page. First-day
and borrowed-speed estimates are labeled. No recent reading means no return
date; estimates beyond a year have no precise date. **`median-windows`**,
the median of 7/14/30/60-day blended predictions, is shown for comparison.

The ungated blend led recent-history error among the leading candidates;
multi-window pace led full-history error. The tuned joint simulator did not
beat these on later point predictions. This is a practical choice, not proof
of a universally best model: evaluation periods have been reused.

**Uncertainty:** replay daily predictions, then estimate the distribution of
actual/predicted remaining days using weighted Kaplan–Meier. Each other book
has equal total weight; separate recently read and over-seven-day-idle groups.
Unfinished books are censored. At least 12 other books are required. Widen
the 10th/90th error-factor endpoints by ÷2/×2, selected on mature 2024 origins
by interval score. The histogram shows the underlying distribution before
widening, with its full finite tail and unresolved mass. It is not a normal
distribution or a calibrated 80% probability guarantee.

## Backtesting contract

- Predict **every reconstructable open book, every day at 00:00 UTC**. Only
  prefix-visible progress and sessions enter the predictor. Keep cold starts,
  parallel reading, holds and books still unfinished today.
- Main score: cap predicted and actual remaining days at 90, take absolute
  error, average within each book, then across books. Require 90 days of
  follow-up for **every** scored origin. Missing predictions count as 90;
  unfinished outcomes are known only at that capped horizon.
- Develop before 2024, validate on 2024, freeze selection before later
  comparisons. The 2025+ period is reused evaluation, not a pristine holdout.
  Also report uncapped completed-book errors, availability, reading-state
  subgroups, interval score/coverage, CRPS and Brier scores where applicable.
- Resample books and calendar blocks, not independent daily rows. Current
  page counts are assumed fixed; deleted records and earlier edits cannot be
  recovered. Finish labels require corroborating progress.

## Code map and resuming work

| Work | Start here |
|---|---|
| App predictor, speed and calibration | [`finishForecast.ts`](../src/lib/utils/finishForecast.ts) |
| Browser daily replay and scoring | [`forecastHistory.ts`](../src/lib/utils/forecastHistory.ts), [`forecastDiagnostics.ts`](../src/lib/utils/forecastDiagnostics.ts), [`forecast.worker.ts`](../src/lib/utils/forecast.worker.ts) |
| Dialog and distribution | [`FinishForecastModal.svelte`](../src/lib/components/FinishForecastModal.svelte), [`ForecastDistribution.svelte`](../src/lib/components/ForecastDistribution.svelte), [`forecastDistribution.ts`](../src/lib/utils/forecastDistribution.ts) |
| Currently Reading totals | [`ReadingSummary.svelte`](../src/lib/components/ReadingSummary.svelte), [`readingSummary.ts`](../src/lib/utils/readingSummary.ts) |
| Offline daily experiment | [`forecast-daily-data.ts`](../forecast-daily-data.ts) → [`forecast-daily-models.ts`](../forecast-daily-models.ts) → [`forecast-daily-score.ts`](../forecast-daily-score.ts); orchestrated by [`forecast-daily.ts`](../forecast-daily.ts) |
| Joint simulations | [`forecast-joint-context.ts`](../forecast-joint-context.ts) → [`forecast-joint-model.ts`](../forecast-joint-model.ts); search/selection in [`forecast-joint.ts`](../forecast-joint.ts) |
| App/research parity | [`forecast-app-audit.ts`](../forecast-app-audit.ts), [`finish-forecast.test.ts`](../tests/finish-forecast.test.ts) |

1. Read the [model inventory](forecast-models.md), then the relevant
   [daily](forecast-daily-protocol.md) or [joint](forecast-joint-protocol.md)
   protocol for commands and output formats. The [app guide](finish-forecast.md)
   documents calculations and emulator setup.
2. Use an existing private snapshot and a **new output directory**. Preserve
   prediction ledgers, source/code hashes, candidate configurations, rejected
   attempts and frozen selections. Private reports stay under ignored
   `snapshots/`; do not put account data into docs or app bundles.
3. Add a candidate, develop and validate chronologically, then compare on
   identical cohorts. Check calibration as well as point error. For joint
   search, plot attempts and the running minimum with
   `python -m forecast_plot snapshots/forecast-joint/search.json` after installing
   matplotlib in your Python environment.
4. Before promotion, run `forecast-app-audit.ts` against the saved daily ledger,
   unit/type checks and emulator UI checks. Commit `d89b359` preserves the
   original research before promotion. Frozen historical runners may reject
   later app/code hashes intentionally; do not rewrite their old results.

Next useful research: prospective forecast logging with consent, speed
uncertainty, explicit hold/resume intent, and adaptation to changing reading
habits. Current simulations model budget competition and inferred returns,
but do not yet justify replacing the simpler predictor.
