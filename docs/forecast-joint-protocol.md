# Joint reading simulation experiment

This experiment reads the existing September 2026 snapshot and daily replay.
It never connects to a database. Keep private outputs under `snapshots/`.
The app predictor is unchanged.

## Model and search, recorded before scores

Start with daily reading minutes resampled from the visible recent history.
Allocate those minutes among all books open at the forecast origin. Complete
books and redistribute any remaining daily minutes. Predict every original
book from the same simulated future. No simulated book can consume more
minutes than the shared budget permits.

Test incremental changes to budget window and block length, attention weights,
preference for continuing the last book, feedback from simulated reading,
inactivity-dependent returns, and arrivals of synthetic new books. New-book
workloads and arrival/return frequencies can use only earlier visible history.
Never inject the actual future books, sessions, or completion dates.

Use pre-2024 origins with 90 days of follow-up before January 2024 for hill
climbing. Start from a fixed simple model and evaluate one-coordinate neighbors.
Log every attempted configuration and score, including rejected candidates.
Use common budget random streams and fixed seeds. Confirm promising coarse
search candidates at higher Monte Carlo resolution before accepting a step.
Stop after a full neighborhood fails to improve or a recorded finite search
budget. This establishes a local optimum within the tested family, not a
claim that all possible models have been exhausted.

The primary search objective remains mean per-book absolute error in remaining
days capped at 90, matching the prior experiment. Also record mean daily error,
raw daily error sum, median book error, empirical CRPS for capped remaining time,
Brier scores and interval scores. CRPS evaluates the entire simulated
completion distribution. Withheld or unresolved completion times represent
beyond-horizon outcomes, not known finite completion dates.

Select among a small frozen development shortlist using 2024 origins with 90
days of follow-up before January 2025. Freeze the configuration before scoring
2025 onward. That later period has already been inspected in previous research,
so this is reused temporal evaluation, not a pristine holdout. Confirm the
selected configuration with an independent random seed. Report both equal-book
and raw-book-day weights, active/paused/cold/parallel subgroups, and currently
unfinished sensitivity. Keep unfinished books in the primary evaluation.

Use 90-day simulations for development and validation. Run the frozen finalists
through 365 days for the final forecast ledger and multi-horizon diagnostics.
Use the same first 90 simulated days at either horizon. Preserve unresolved
probability mass after day 365. Resample books and calendar blocks for paired
score differences; daily origins are not independent observations.

## Reconstruction limits

Use the same prefix progress, current fixed page counts, edited-row visibility,
label quality checks, and fixed follow-up cohorts as the daily protocol. A
snapshot cannot recover deleted records or old metadata. All simulated states
are ephemeral local objects. Code and source hashes accompany search and final
results. Freeze and retain earlier experiment outputs when changing code.

## Running and inspecting the experiment

Requires Node 22.18 or newer, the existing local snapshot, and the preceding
`forecast-daily.ts` output under `snapshots/forecast-daily/`. The joint runner
checks that the two experiments use the same snapshot hash. It shares the
original feature states and scoring cohorts, so comparisons have identical
book-day denominators.

```bash
node forecast-joint.ts build <snapshot.json> <account-email> snapshots/forecast-joint
node forecast-joint.ts search <snapshot.json> <account-email> snapshots/forecast-joint
node forecast-joint.ts validate <snapshot.json> <account-email> snapshots/forecast-joint
node forecast-joint.ts final <snapshot.json> <account-email> snapshots/forecast-joint
node forecast-joint-audit.ts <snapshot.json> <account-email> snapshots/forecast-joint
node forecast-joint-report.ts <snapshot.json> <account-email> snapshots/forecast-joint
npm run test:forecast-joint
npm run check:node
```

Use a new output directory for a new experiment; stage commands overwrite
files. `contexts.json` contains only historical model inputs. `search.json`
records every attempted configuration and simulation resolution, the accepted
path, and shortlist. `selection.json` freezes the validation choice. `final`
writes one JSONL file per finalist with all 256 sampled completion times per
book-day, then scores the original baselines on the same cases. Null samples
mean unresolved at the simulation horizon. Development uses 90-day paths;
final evaluation uses 365-day paths without changing their first 90 days.

The extended grid searches budget windows of 14/30/60/90/180 days, blocks of
1/3/7 days, attention windows of 7/14/30/60/90 days, powers of 0.5/1/2/4,
and age adjustment. It also searches persistence, feedback, pauses, return
frequency scaling, new-book arrivals, and 30-minute versus whole-day chunks.
The initial four-round experiment was preserved before extending the grid.
The maximum is eight accepted-search rounds. Coarse screening uses 32 paths;
confirmation uses 128. Before stopping for no improvement, all neighbors get
128 paths. An improvement must exceed 0.02 days. Validation uses 256 paths.

The empirical CRPS implementation scores the forecast's finite ensemble. It
uses E|X-y| minus half E|X-X'| with both draws taken from the empirical sample.
It does not apply the fair-ensemble correction. Final models all use the same
256-path resolution. Initial remaining reading minutes are point estimates;
uncertainty in reading speed is not yet included.

`audit.json` checks all final distributions, samples, and a spaced sample of
resource-conserving paths. It compares intervals on precisely the cases where
the app supplies its existing historical range, measures independent-seed
variation, and records book-level regressions and named-outlier sensitivity.
`report.html` is a self-contained private viewer with model, period and book
selectors, quantile charts, daily forecasts, and every search attempt. Keep its
neighboring Markdown, CSV and JSON files together for the report links.

The experiment log records a floating-point completion fix found during the
code audit. Pre-fix outputs are preserved, and the unchanged search procedure
was rerun after the repair. No parameters were manually selected in response
to the later-period scores. That period remains reused evaluation.

## References

- [Block bootstrap for dependent time series](https://otexts.com/fpp3/bootstrap.html)
- [CRPS for ensemble forecasts](https://scoringrules.readthedocs.io/en/latest/generated/scoringrules.crps_ensemble.html)
- [Empirical and fair ensemble scoring](https://scoringrules.readthedocs.io/en/latest/crps_estimators.html)
