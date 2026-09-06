# Forecast model inventory

[Start here](forecasting.md) for the current model, scoring contract and code map.
Names below match the saved experiment ledgers. Brace notation lists variants,
not additional unnamed models.

## Fixed candidates: 51 models

The original 19 candidates live in [`forecast-candidates.ts`](../forecast-candidates.ts).
The daily experiment adds 17 rate/control variants and 15 historical-analogue
variants in [`forecast-daily-models.ts`](../forecast-daily-models.ts).

| Family | Exact model names / variants | Idea |
|---|---|---|
| Original dashboard | `existing-30` | Remaining time / overall 30-day pace, with its original activity gate and unfiltered speed |
| Own pace | `book-{7,14,30,60,90}`, `lifetime` | Remaining time / this book's recent or lifetime pace |
| Blended pace | `blend-{14,30,60}` | Geometric mean of own and overall daily pace; original two-day requirement |
| Allocated budget | `allocated-{14,30,60}-{0.5,1}` | Overall budget times a power of this book's active reading share |
| Independent simulation | `simulation-30` | Resample daily budgets and probabilistically allocate days to one target book |
| Return-time models | `renewal`, `renewal-after-7` | Estimate return wait from censored historical gaps, then add resumed reading time |
| Controls | `always-later`, `constant-{7,30}` | Expose rewards for withholding dates or using a fixed guess |
| Decayed pace | `ewma-{7,14,30}` | Exponentially weighted own pace, with the named half-life |
| Budget / regularization | `budget-{14,30}`, `regularized-{14,30}` | Bound the blend by total reading budget; shrink own pace toward a shared-budget prior |
| Multi-window | `median-windows`, `median-windows-gated` | Median of 7/14/30/60-day blends, with or without the two-day requirement |
| Gate ablations | **`blend-14-ungated`**, `budget-14-gated` | Test the first-day requirement separately from the pace formula |
| Pause decay / switching | `resume-decay-{7,14}`, `state-window` | Decay resumed pace during inactivity; switch median/budget models at seven idle days |
| Historical analogues | `analogue-{context,pace,pause,ratio,median-ratio}-{12,24,48}` | Nearest earlier states from other books; censored completion-time or residual distributions |

The analogue variants change distance weights or predict errors relative to
the blend/multi-window baseline. Each training book contributes at most one
nearest landmark; training outcomes must be observable at the training cutoff.
An annual selection policy was also evaluated separately from these 51 fixed
models, using only sufficiently mature outcomes available before each year.

## Joint queue simulation

[`forecast-joint-model.ts`](../forecast-joint-model.ts) simulates all open books
together with one finite reading budget per day. Completing a book frees the
remaining minutes for another. The search tested 140 distinct configurations
in 188 evaluations, including higher-resolution confirmations; it did not
exhaust the Cartesian product below.

| Parameter | Search values | Meaning |
|---|---|---|
| `budgetWindow` | 14, 30, 60, 90, 180 | Days of budget history |
| `block` | 1, 3, 7 | Consecutive-day resampling block |
| `attentionWindow` | 7, 14, 30, 60, 90 | Book attention history |
| `sharePower` | 0.5, 1, 2, 4 | Strength of attention preference |
| `exposureAdjustment` | false, true | Adjust attention for recently started books |
| `stickiness` | 0, 0.5, 0.85 | Preference for the previous book |
| `feedback` | 0, 0.5, 1 | Update attention from simulated reading |
| `pauseAfter` / `returnScale` | 0, 7, 14, 30, 60 / 0, 0.5, 1, 2 | Inactivity threshold and historical return intensity |
| `arrivalScale` | 0, 0.5, 1 | Synthetic future book arrivals |
| `chunk` | 0, 30 | Whole daily allocation or 30-minute chunks |

Saved final variants: `joint-simple`, `joint-development`, `joint-selected`,
`joint-without-pauses`, and `joint-seed2`. Development screens use 32 paths,
confirmations 128, and final comparisons 256. Development/validation simulate
90 days; final distributions retain unresolved paths after 365 days.

The validation-selected configuration uses a 90-day budget window, independent
days, 30-day attention, age adjustment, power 2, a seven-day pause threshold
and return scale 1; stickiness, feedback, arrivals and chunking are disabled.
The exact development minimum differs from the accepted hill-climb endpoint:
improvements smaller than 0.02 days did not move that endpoint. `search.json`
retains both the individual scores and accepted path; the frontier plot uses
the actual running minimum, not just accepted steps.

## What the experiments support

The daily experiment favored `median-windows` in validation. The ungated
14-day blend was slightly better on the reused later period and became the
app default; multi-window remains a comparison. Joint hill climbing improved
its own starting simulator, especially on dormant books, but did not beat the
strong simple models on later point errors. Its raw 10th–90th quantiles also
under-covered. Keep it in research until both accuracy and calibration improve.

Account-specific scores and per-book misses belong in the private daily/joint
reports, not this inventory. See the [daily protocol](forecast-daily-protocol.md),
[joint protocol](forecast-joint-protocol.md) and [promotion audit](../forecast-app-audit.ts)
for reproducible comparisons and their limits.
