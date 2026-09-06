# Daily completion-forecast experiment

## Protocol recorded before the daily leaderboard

Use the existing local snapshot only. Run one forecast at 00:00 UTC on every
calendar day from the first recorded progress through the snapshot. Replay
all books with recorded progress that have not reached their page count in
the visible prefix. Keep cold starts and all lengths of inactivity. Do not
filter the prediction population by today's finished status. Books without
progress history cannot be reconstructed and are counted separately.

Current page count is assumed fixed. A snapshot cannot recover deleted
books, deleted sessions, old metadata, or earlier versions of edited rows.
Rows edited after a cutoff are omitted until the edit becomes visible.
Completion labels require a corroborating final progress event. Those labels
are for scoring only, never for reconstructing features or active-book lists.

## Scores and censoring

Primary: mean absolute error in remaining days capped at 90, averaged first
within each book, then across books. Include only origins at least 90 days
before the evaluation cutoff. This fixed follow-up cohort avoids selecting
recent cases just because they finished quickly. An unfinished book then
has a known capped outcome of 90 days; its actual eventual finish stays
unknown. Missing or infinite point predictions receive the 90-day prediction
penalty. Compare against an always-beyond-horizon control to expose rewards
for abstaining on dormant books.

Also report raw summed daily error, error per book-day, error per calendar
day with equal weight across that day's books, median and p90 book error,
30/180/365-day horizons, and completed-only uncapped errors with forecast
availability. Completed-only scores are sensitivity analyses, not the main
selection criterion. Report idle-state, parallel-reading, cold-start, year,
and current-unfinished subgroups, with counts.

Probabilistic candidates supply completion CDFs and quantiles. Score Brier
loss at 7/30/90/180/365 days on fixed mature cohorts, plus an 80% interval
score and coverage for the distribution of remaining days capped at 90.
A capped endpoint at 90 is not a finite 90-day calendar completion claim.
Point-only models have degenerate step CDFs, explicitly labeled as such.
Never compare range coverage alone; a wide range can cover almost everything.

## Candidates and evaluation

Re-score all 19 existing candidates on the same daily cases. Add controls,
exponentially decaying pace, regularized shared-budget forecasts, and
historical-analogue survival distributions. Analogue training landmarks are
weekly; evaluation remains daily. Only earlier landmarks and outcomes
observable at the forecast's training cutoff may inform a model. Exclude
the target book from analogue training, limit each training book to one
closest landmark, and include unfinished training outcomes as censored.

Develop on data before 2024, evaluate the fixed shortlist on 2024, then freeze
selection before viewing the new 2025 onward results. Also evaluate an annual
selection policy that picks a model using only sufficiently mature outcomes
available before each year. Full-history rankings of fixed candidates are
retrospective diagnostics, not an untouched test set. The earlier experiment
already examined 2025 onward, so this round cannot claim a pristine holdout.

Quantify paired differences with book resampling and calendar-block resampling,
not independent resampling of highly correlated daily predictions. Record
all candidates, selection decisions, source/code hashes and forecast rows.
No app model replacement, production write, or deployment is part of this
experiment. A promising research model must retain honest uncertainty and
show useful performance on both active and paused books before promotion.

## References

- [Rolling forecast origins](https://otexts.com/fpp3/tscv.html)
- [Survival evaluation and censoring](https://scikit-survival.readthedocs.io/en/stable/user_guide/evaluating-survival-models.html)
- [Administrative censoring and Brier scores](https://arxiv.org/abs/1912.08581)

## Running the experiment

The scripts read an existing JSON snapshot and have no database client. Run
from the repository root with Node 22.18 or newer. Keep outputs in the ignored
`snapshots/` directory because they contain personal reading histories.

```bash
node forecast-daily.ts build <snapshot.json> <account-email> snapshots/daily-experiment
node forecast-daily.ts develop <snapshot.json> <account-email> snapshots/daily-experiment
node forecast-daily.ts validate <snapshot.json> <account-email> snapshots/daily-experiment
node forecast-daily.ts final <snapshot.json> <account-email> snapshots/daily-experiment
node forecast-daily-audit.ts <snapshot.json> <account-email> snapshots/daily-experiment
node forecast-daily-report.ts <snapshot.json> <account-email> snapshots/daily-experiment
npm run test:forecast-daily
npm run check:node
```

`build` saves every daily feature state and forecast in `predictions.jsonl`.
`develop` ranks candidates using outcomes available before 2024. `validate`
selects from that shortlist using 2024, with 90 days of follow-up before
January 1, 2025. `final` verifies source and code hashes before opening the
remaining comparisons. Use a new output directory for a new experiment;
these commands overwrite their outputs. Preserve earlier development results
when adding candidates. The report's interpretive prose records the September
2026 experiment; update that prose before using it to describe a new dataset.

The fixed candidates include the original 19 models, constant and abstention
controls, 7/14/30-day exponentially weighted rates, shared-budget and
regularized rates, a median across four windows, two pause-decay models, and
first-day guard ablations. Fifteen analogue variants compare pace, inactivity,
broader book state, and normalized residuals with 12, 24 or 48 training books.
All random draws use fixed seeds. An annual selection policy is evaluated
separately from the 51 fixed candidates.

`results.json` contains horizon, year and reading-state breakdowns, paired
resampling intervals and annual selections. `scores.csv` contains the complete
main leaderboard. `audit.json` adds common-issued-date comparisons, alternative
deferral costs, matched uncertainty scores, completed-only and named-outlier
sensitivities, and a full replay at noon UTC. `report.html` is self-contained
and can be opened locally to inspect each book and prediction. Its links to
the Markdown report, CSV and JSON work when those files stay together.

These files are research tools. They do not replace the app's predictor or
change its calibration. No emulator or production access is needed to rerun
the experiment.
