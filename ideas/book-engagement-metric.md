# Behavioral book engagement metric

Status: research note, no implementation work started  
Written: 2026-08-24  
Data inspected: `snapshots/2026-08-23T22-39-33.234Z-prod.json`

## Goal

Derive a personal measure of how strongly a book pulled the reader back, using reading behavior instead of a star rating.

"Behavioral pull" is a better name than "book quality." The data can show that a book repeatedly won the reader's time and attention. It cannot cleanly separate enjoyment from readability, difficulty, obligation, available free time, or the reader's reasons for choosing the book.

The metric should answer questions such as:

- Was this book unusually hard to put down?
- After stopping, did the reader choose it again at the next opportunity?
- Did it hold attention when other books were available?
- Did the reading pace intensify near the end?

## Available data

Each timed reading session has:

- Book reference
- Creation timestamp
- Minutes read
- Starting and ending page
- Pages read

Each book has:

- Page count and current page
- Aggregate pages and minutes read
- Finished state
- Creation and update timestamps
- Author IDs
- ISBN-derived metadata fields

Page-only updates have timestamps and page positions but no duration. They can establish activity and completion dates, but they should not contribute to session-duration or reading-speed measures.

The current data is large enough for a personal metric:

- 171 books, of which 161 are finished
- 2,684 timed reading sessions and 81 page-only updates
- 169 books with at least one timed session
- Median of 14 timed sessions per book
- 159 books with at least four sessions
- 140 books with at least eight sessions
- Reading history from December 2020 through August 2026
- Median session duration of 28 minutes
- Middle 50 percent of sessions range from 19 to 39 minutes
- Median per-book average session duration of about 31 minutes
- 2,007 of 2,683 consecutive reading-session transitions, about 75 percent, stayed on the same book

Some data needs special handling:

- 22 sessions are shorter than five minutes.
- Two sessions have zero or negative pages.
- One session exceeds 150 pages per hour.
- Eighteen books first appear after page 10, so the data does not cover their full reading history.
- Subjects, fiction classification, and publication date are currently unpopulated. Genre correction is therefore unavailable.
- Author data is populated. There are 141 unique authors, but only 18 have two or more books, so author-controlled comparisons would apply to a minority of the library.

## Recommended first score

Use three personalized components:

\[
\text{Pull Score} = 0.55R + 0.30D + 0.15C
\]

Convert each component to a percentile among the reader's books before combining them. The resulting score runs from 0 to 100.

This formula is a starting hypothesis, not a settled model. Return behavior receives the most weight because it expresses an actual choice to resume the book.

### Return pull, 55 percent

After each nonterminal session, count how many reading sessions on other books occurred before the reader returned to this book.

This uses reading opportunities instead of wall-clock time. A week during which the reader read nothing does not count against the book. A week spent reading three other books does.

One possible session-level score is:

\[
r = e^{-k/2}
\]

Here, \(k\) is the number of intervening sessions on other books. An immediate return scores 1. Returns after one or more competing sessions receive progressively less credit.

Average the session scores for the book. Exclude the final session of a finished book because another return is impossible. Treat the latest session of a current book as censored, not as a failed return.

Related measures worth retaining for explanations:

- Probability that the next reading session is the same book
- Median number of other-book sessions before returning
- Whether the reader returned on the next day when any reading occurred
- Return rate when at least one other book was active

Returning to the only active book provides weaker evidence than choosing it over several alternatives. A later version could adjust each return for the number of active choices.

### Session depth, 30 percent

Longer sessions may mean the book was harder to put down. Compare each session with the reader's normal behavior under similar circumstances, rather than with one lifetime mean.

A useful session residual is:

\[
d = \log(\text{session minutes}) -
\operatorname{expected}[\log(\text{session minutes}) \mid
\text{recent period, time band, weekday}]
\]

For example, compare a Sunday-morning session with other Sunday-morning sessions from roughly the same period. Do not compare it directly with rushed weekday sessions from several years earlier.

Use the median residual across the book's sessions. The logarithm and median prevent one unusually long train ride or vacation day from dominating the result.

A rolling six-month or one-year baseline should handle long-term habit changes and most seasonal variation. Broad time bands and a weekday-versus-weekend distinction should be sufficient at first. A separate parameter for every hour, weekday, month, season, and year would overfit the data.

### Reading concentration, 15 percent

Measure how much of the reader's available reading attention the book captured between its first and last sessions.

Two useful measures are:

\[
\frac{\text{days this book was read}}
{\text{days any book was read during its active span}}
\]

and

\[
\frac{\text{minutes spent on this book}}
{\text{all reading minutes during its active span}}
\]

These measures control for busy periods while still detecting books that repeatedly lost attention to other books.

The definition of an "active" competing book needs care. Treating the full interval from its first to last session as active may count a book that was abandoned for months. A reasonable first rule could use a limited inactivity window around each session.

## Elapsed time and completion speed

Elapsed days divided by total reading hours measures how dispersed the reading was:

\[
\frac{\text{elapsed calendar days}}{\text{total timed reading hours}}
\]

Lower values mean the reading was concentrated. Pages per elapsed day mixes this concentration with reading speed.

These are useful explanatory statistics, but they largely recombine session length and return frequency. Adding them at full weight would reward the same behavior twice.

A schedule-adjusted version replaces calendar days with days on which the reader read anything:

\[
\frac{\text{total reading minutes for the book}}
{\text{reader-active days during the book's span}}
\]

Both views may be worth showing:

- Opportunity-adjusted concentration asks whether the book won when reading occurred.
- Calendar concentration asks whether the book was compelling enough to make the reader create more reading opportunities.

## Other signals worth exploring

### Choice share among concurrent books

For periods with several active books, measure what share of sessions or minutes went to each book. This may be one of the strongest signals because it observes direct competition for attention.

### Late-book acceleration

Compare the first and second halves of the observed page range:

- Did session-duration residuals rise?
- Did return gaps shrink?
- Did the book capture a greater share of reading opportunities?

An increase may show that the book became more gripping. This requires enough sessions and adequate coverage of the book. The 140 books with at least eight sessions should support an exploratory version.

### Finishing sprint

Compare behavior in the final 20 percent of pages with the preceding part of the book. A long final session or rapid sequence of final sessions may show a desire to finish. Deadlines and planned reading can produce the same pattern, so this should remain an explanatory trait rather than a large score component.

### Short-session and marathon rates

Count how often a book produced sessions below the reader's contemporary 25th percentile or above the 75th or 90th percentile. This is easier to explain than a regression residual, though less precise.

### Dormancy and abandonment

An unfinished book with no activity for a long period contains negative behavioral evidence. Do not penalize a current book simply because its next session has not happened yet. A dormancy threshold, such as 60 days, can distinguish current reading from likely abandonment.

Only ten books in the current snapshot are unfinished, so completion is not useful for ranking the many finished books. It may still help evaluate whether an early engagement score predicts later outcomes.

### Reading-speed change

Pages per hour is mostly a readability and page-density measure across books. Dense nonfiction should not receive a poor engagement score because it reads slowly.

Within-book speed changes are more defensible. If pace rises in the later portion of the same book, that may support an acceleration interpretation. Speed should remain secondary unless subject or format metadata becomes reliable.

### Reading past the normal stopping time

This would be a plausible "kept me up" signal, but the current timestamp records when the session was saved. The database does not preserve a reliable session start time or whether the reader used a timer. Manually logged sessions can be delayed. This signal is too noisy for the current score.

### Recovery after interruption

A strong return after an unusually long interruption may indicate commitment. It may also indicate obligation, so it is better as a descriptive trait than a score component.

## Adjustments and non-adjustments

Use these adjustments:

- Rolling historical baseline for changes in reading habits
- Broad time-of-day and weekday adjustment for session length
- Reading opportunities instead of calendar time for the core return measure
- Competing active books for choice-based measures
- Observed page coverage for early-versus-late measures
- Reliability shrinkage for books with few sessions

Avoid these adjustments at first:

- Genre, because the metadata is empty
- Author, because author preference is part of personal engagement and repeat-author coverage is limited
- Page count as a blanket correction, because return pull and median session depth are already fairly insensitive to length
- A large set of independent calendar effects, because a rolling baseline should capture most of them with less overfitting

## Reliability

Shrink sparse component scores toward the neutral value of 50:

\[
\text{adjusted component} =
50 + \frac{n}{n+5}(\text{raw component} - 50)
\]

Here, \(n\) is the number of usable sessions or return opportunities.

Suggested evidence labels:

- Fewer than four sessions: insufficient evidence
- Four through seven sessions: provisional
- Eight or more sessions: reasonably stable

These thresholds would produce reasonably stable estimates for about 140 books in the current data.

## Validation without ratings

The metric cannot be validated against explicit preference if no rating or other feedback exists. It can still be tested for internal usefulness:

1. Compute the score using only the first 25 or 50 percent of a book's observed progress.
2. Test whether it predicts later return frequency, concentration, finishing acceleration, or eventual completion.
3. Check whether one added session causes large ranking changes.
4. Inspect the highest and lowest books for obvious data artifacts.
5. Compare books by repeat authors as a limited within-author check.
6. Check whether the score merely reproduces reading speed, page count, or year read. Strong correlations would reveal unwanted confounding.

The most useful informal validation is whether the top and bottom results make autobiographical sense. Surprises should have readable explanations such as "returned immediately after 82 percent of sessions" rather than a score with no traceable cause.

## Recommended next step when work resumes

Start with a research calculation, not a product feature:

1. Calculate return pull and adjusted session depth for books with at least four sessions.
2. Examine their distributions and correlation.
3. Add concentration only if it contributes information that the first two components miss.
4. Produce a private table with component values, reliability, and short explanations.
5. Review the apparent top and bottom books before choosing weights or UI language.

The cleanest minimal metric may ultimately use only return pull and session depth. Concentration, acceleration, completion, and speed can appear as supporting traits without being folded into one number.

## Relevant project files

- `src/lib/interfaces/book.ts` defines stored book fields.
- `src/lib/firebase/db.js` defines reading-session and page-update writes.
- `src/lib/utils/sessions.js` contains the existing timeline, cadence, speed, completion, and projection derivations.
- `src/lib/utils/stats.js` defines the shared three-hour day-boundary convention.
- `src/lib/components/SpeedSection.svelte`, `ProgressSection.svelte`, `CadenceSection.svelte`, and `ClockSection.svelte` show the current analytics vocabulary and presentation.
