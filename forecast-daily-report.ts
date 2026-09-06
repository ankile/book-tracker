// Build a private, self-contained inspection report; no external services.
// node forecast-daily-report.ts <snapshot.json> <email> <private-output-directory>
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {snapshotBooks,type DailySnapshot} from './forecast-daily-data.ts';
import {type DailyPrediction} from './forecast-daily-models.ts';
import {type evaluate,actual} from './forecast-daily-score.ts';
const [file,email,directory]=process.argv.slice(2);
assert.ok(file&&email&&directory&&resolve(directory).startsWith(resolve('snapshots')+'/'));
type Score=NonNullable<ReturnType<typeof evaluate>>;
const results=JSON.parse(readFileSync(resolve(directory,'results.json'),'utf8')) as {scores:{all:Score[];recent:Score[]};selection:{selected:string};paired:unknown;choices:unknown;subgroups:Record<string,Score[]>;years:Record<string,Score[]>};
const manifest=JSON.parse(readFileSync(resolve(directory,'manifest.json'),'utf8'));
const audit=JSON.parse(readFileSync(resolve(directory,'audit.json'),'utf8'));
const snapshot:DailySnapshot=JSON.parse(readFileSync(file,'utf8'));
const asOf=Date.parse(snapshot.takenAt),books=snapshotBooks(snapshot,email);
const rows:DailyPrediction[]=readFileSync(resolve(directory,'predictions.jsonl'),'utf8').split('\n').map(line=>JSON.parse(line));
const names=manifest.models as string[];
const n=(v:number)=>v.toFixed(2),pct=(v:number)=>(100*v).toFixed(1)+'%';
const table=(scores:Score[])=>'| Model | Mean book error | Median book error | Mean daily error | Summed daily error | Dates within 1 year |\n|---|---:|---:|---:|---:|---:|\n'+scores.map(r=>`| ${r.model} | ${n(r.macro)} | ${n(r.medianBook)} | ${n(r.micro)} | ${n(r.sum)} | ${pct(r.dateRate)} |`).join('\n');
const featured=['existing-30','blend-14','blend-14-ungated','median-windows','state-window','ewma-7','annual-policy','always-later'];
const selected=results.scores.all.find(r=>r.model===results.selection.selected)!;
const old=results.scores.all.find(r=>r.model==='blend-14')!;
const recent=results.scores.recent.find(r=>r.model===results.selection.selected)!;
const oldRecent=results.scores.recent.find(r=>r.model==='blend-14')!;
const markdown=`# Daily reading forecast experiment

Snapshot: ${snapshot.takenAt}. All work used this local file; no database client is involved.

## What changed

The harness replays ${manifest.dailyCutoffs} daily cutoffs at 00:00 UTC between December 9, 2020 and September 5, 2026. ${manifest.calendarDays} cutoffs have a reconstructable open book. It produces ${manifest.cases} book-day cases across ${manifest.reconstructedBooks} books and ${manifest.models.length} fixed candidates, for ${manifest.cases*manifest.models.length} predictions. An annual model-selection policy is evaluated separately.

The main 90-day score uses ${selected.bookDays} cases from ${selected.books} books, each with at least 90 days of follow-up. ${manifest.cases-selected.bookDays} recent cases remain in the prediction ledger but not this score. Five books started and finished between the midnight cutoffs; three have no progress history. A separate noon-UTC replay checks cutoff sensitivity.

## Main result

The frozen development/validation winner is median-windows. It takes the median of four calendar-time forecasts based on 7, 14, 30 and 60-day blended rates. It also makes provisional predictions before the second reading day.

${table(results.scores.all.filter(r=>featured.includes(r.model)))}

These are remaining-day absolute errors capped at 90 days. Mean book error averages daily errors within a book before averaging across books. Mean daily error gives every book-day equal weight. Summed daily error is exactly the unnormalized sum requested; it favors the same model as mean daily error on this common cohort. Missing forecasts are scored as predicting 90 or more days, so this main score evaluates a forecast policy as well as its numeric accuracy. It is not an uncertainty interval.

State-window has the best retrospective full-history book score, but it lost the pre-2025 validation comparison. EWMA-7 minimizes the raw full-history daily sum. Neither is substituted for the frozen winner after seeing these results. There is no single best model independent of the weighting and decision objective.

## Evaluation from 2025 onward

${table(results.scores.recent.filter(r=>featured.includes(r.model)))}

The frozen winner reduces mean book error from ${n(oldRecent.macro)} to ${n(recent.macro)} days, a ${pct((oldRecent.macro-recent.macro)/oldRecent.macro)} reduction. Its pooled daily error is effectively tied and slightly worse, ${n(recent.micro)} versus ${n(oldRecent.micro)}. The prior experiment already examined 2025 onward, so this is a reused evaluation period, not a pristine holdout. All features and fitted outcomes still obey their historical cutoffs.

## The gain is mostly the first-day policy

The existing two-reading-day guard gave no date on many short books' early days. Counting those as 90-day forecasts makes the overall score much worse. Removing that guard alone gets almost all the improvement. On 2,827 mature cases where both the existing and selected models issue dates within a year, the existing formula scores 9.01 days and the new formula 9.08 days. On all cases with at least two reading days, the scores are 8.84 and 8.76 days.

Against the ungated 14-day formula, the multi-window median's full-history advantage is only 0.094 days. Its 95% book-resampling interval is roughly -0.04 to +0.24 days, and the calendar-block interval is -0.06 to +0.24. This does not establish a meaningful improvement in the underlying pace formula. The larger comparison against the currently guarded model reflects a decision to offer provisional forecasts earlier.

The audit also evaluates deferral costs of 7, 14 and 30 days instead of treating every withheld forecast as a 90-day prediction. Those results are in audit.json. The recommendation depends on how valuable an early, uncertain date is compared with no date.

## Keep unfinished books in the main score

Seven currently unfinished books have mature 90-day cases. They contribute 3,400 of 8,405 scored book-days, about 40%, but only 7 of 161 book weights, about 4%. The Bible and the dissertations book alone contribute roughly a quarter of raw book-day observations. This is a reason to expose weighting, not to remove those outcomes.

For an unfinished book with 90 days of follow-up, the capped outcome is known to be 90. Its eventual completion date remains unknown. Excluding books because they are unfinished today conditions the historical evaluation on future success and removes exactly the long pauses the model should recognize. Use completed-only analysis for the conditional question of accuracy on books eventually finished. The median-windows completed-only score is 9.23 days, compared with 9.14 including unfinished cases. The sensitivity analysis also separately removes just the Bible and dissertations book.

An always-later control scores perfectly on the currently unfinished subset. It scores 72.39 days overall, which shows why that subset alone cannot select a useful model. Uncapped completed-only errors and forecast availability are also reported; those errors cannot be fairly assigned to unfinished books.

## Uncertainty did not get solved by a more complex model

The analogue models find similar past book states using remaining reading, inactivity, pace, progress and concurrent books. They take at most one weekly landmark per other book and fit weighted Kaplan-Meier curves using outcomes observable at each month's training cutoff. Unfinished cases remain censored. Residual variants scale historical actual-to-predicted-time ratios to the current pace forecast.

On the same 2,582 mature cases where the app can provide a historical range, its current range has a bounded 80% interval score of 50.68, book-weighted coverage of 96.8%, and mean width of 46.8 days. The 48-neighbor median-residual model gives narrower ranges, averaging 30.2 days, but covers only 67.9% and scores 51.08. It has not beaten the broad current range on the interval score. In the 2025 onward comparison the app range also scores best among those tested. All these interval endpoints and outcomes are capped at 90 days for this diagnostic; 90 means 90 or more, not a promised finish by day 90.

Brier scores at 7, 30, 90, 180 and 365 days use fixed mature cohorts. Point-only models are scored as degenerate step CDFs, not calibrated probability forecasts. Censored survival mass beyond observed events stays in the unresolved tail. Do not read a model's nominal 10th-to-90th quantiles as a proven 80% coverage guarantee.

## What I would change next

First, investigate a clearly labeled provisional date after the first usable session, with uncertainty specific to that early state. The simple ungated 14-day formula is competitive with the new multi-window median. The new rate formula alone has not earned a strong superiority claim.

Keep long pauses as an explicit state, and evaluate return-to-reading separately from time-to-finish after returning. The tested renewal and analogue approaches did not reliably solve return timing. A future joint queue simulation could explicitly redistribute daily reading capacity when another book finishes, with a model for starting new books. That is a stronger parallel-reading hypothesis than treating each book independently. A larger model should be judged against the simple ungated baseline, not against the old first-day abstention penalty.

Do not automatically switch models each year. The prequential annual selector scored ${n(results.scores.all.find(r=>r.model==='annual-policy')!.macro)} days over the full history; it overreacted to the smaller training windows. Its choices and their training sizes are recorded in results.json.

## Reproducibility and limitations

Run the build, develop, validate and final stages of forecast-daily.ts in that order. The manifest and selection files pin the source and model/scoring code hashes. forecast-daily-audit.ts checks every forecast for valid probabilities and quantiles, compares first-day ablations and deferral costs, scores the actual app range on a common cohort, and repeats predictions at noon UTC. forecast-daily-report.ts builds this report and the interactive viewer.

Tests cover quiet days and multi-year holds, cold starts, future-session and future-outcome exclusion, historical parallel state, target-book exclusion from analogue fitting, censoring, daily aggregation weights, monotone survival distributions and annual selection cutoffs. The noon replay gives the frozen winner 9.33 days versus 22.05 for the guarded blend, consistent with the primary replay.

Current page counts are assumed constant because the database has no complete metadata history. Deleted books, deleted sessions and earlier versions of edited rows are unrecoverable. Edited rows are omitted until their update timestamp is visible. Books completed entirely between daily cutoffs have no daily forecast; they are not silently treated as correctly predicted. Scores are conditional on the recorded library and observed logging behavior. Correlated book-days are not independent samples. Paired uncertainty uses book resampling and 90-day calendar blocks, with only seven blocks in the recent period. Candidate development and the repeated use of old data limit formal significance claims.

Source SHA-256: ${manifest.sourceHash}

Model/scoring code SHA-256: ${manifest.codeHash}

## All fixed candidates and the annual policy

${table(results.scores.all)}

## References

- [Rolling-origin evaluation](https://otexts.com/fpp3/tscv.html)
- [Survival metrics and censoring](https://scikit-survival.readthedocs.io/en/stable/user_guide/evaluating-survival-models.html)
- [Administrative censoring and the Brier score](https://arxiv.org/abs/1912.08581)
`;
writeFileSync(resolve(directory,'report.md'),markdown);
const data={manifest,scores:results.scores,years:results.years,selected:results.selection.selected,
  names,books:books.filter(book=>rows.some(row=>row.row.bookId===book.id)).map(book=>({id:book.id,title:book.title})),
  rows:rows.map(item=>({book:item.row.bookId,at:item.row.at,progress:item.row.progress,idle:item.row.idle,remaining:item.row.remaining,
    actual:Number.isFinite(actual(item,asOf))?actual(item,asOf):null,mature:item.row.at<=asOf-90*86400000,
    models:names.map(name=>{const d=item.models[name];return [d.days,d.lower,d.upper,...d.cdf,d.support];})}))};
const payload=JSON.stringify(data).replaceAll('<','\\u003c');
writeFileSync(resolve(directory,'report.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Daily book forecast experiment</title>
<style>body{font:15px/1.55 system-ui,sans-serif;color:#213439;background:#f1f5f5;margin:0}main{max-width:1200px;margin:auto;padding:32px 22px}h1{font-size:30px;margin:0}h2{margin-top:35px;font-size:21px}p{max-width:1000px}.muted,small{color:#546a70}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card{background:white;border:1px solid #d2dfe0;border-radius:8px;padding:16px}.card strong{font-size:25px;display:block}.controls{display:flex;gap:18px;flex-wrap:wrap;background:white;padding:16px;border:1px solid #d2dfe0;border-radius:8px}label{display:grid;gap:5px;flex:1;min-width:180px}select,button{font:inherit;padding:8px;border:1px solid #a7bec2;border-radius:4px;background:white}button,select{cursor:pointer}button:focus-visible,select:focus-visible{outline:3px solid #24727a;outline-offset:2px}.table{overflow:auto;max-height:500px;background:white;margin:15px 0}table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:9px 12px;border-bottom:1px solid #dde6e6}th{position:sticky;top:0;background:#e9f0f0;white-space:nowrap}td{font-variant-numeric:tabular-nums}tr.selected{background:#e7f4f2}svg{width:100%;height:auto;background:white;border:1px solid #d2dfe0;border-radius:7px;margin-top:18px}.legend{display:flex;gap:20px;flex-wrap:wrap;font-size:13px}.notice{border-left:4px solid #70989e;background:white;padding:15px}a{color:#12666e}.pager{display:flex;gap:12px;align-items:center}@media(max-width:700px){.cards{grid-template-columns:1fr 1fr}main{padding:20px 12px}h1{font-size:25px}}</style>
<main><p class="muted">Private local analysis · September 5, 2026 snapshot</p><h1>Every day, every open book</h1><p>Nearly six years of reading, replayed with only the information available at each forecast date. Compare all 51 fixed candidates and inspect every daily prediction.</p>
<div class="cards"><div class="card"><strong>${manifest.dailyCutoffs}</strong>daily cutoffs</div><div class="card"><strong>${manifest.cases}</strong>book-day forecasts per model</div><div class="card"><strong>${selected.bookDays}</strong>cases with 90-day follow-up</div><div class="card"><strong>${selected.books}</strong>books in the primary score</div></div>
<p class="notice"><b>The main gain is earlier forecasts.</b> The selected median-of-windows model scores ${n(selected.macro)} days versus ${n(old.macro)} for the current guarded model. Simply removing the first-day guard scores 9.24. On common issued dates, the old and new formulas are essentially tied. A withheld forecast is scored as predicting 90 or more days.</p>
<p><a href="report.md">Full findings and limitations</a> · <a href="scores.csv">Download all model scores</a> · <a href="audit.json">Audits and sensitivity checks</a></p>
<h2>Model comparison</h2><div class="controls"><label>Evaluation period<select id="period"><option value="all">Full history</option><option value="recent">2025 onward, reused evaluation period</option></select></label><label>Rank models by<select id="ranking"><option value="macro">Equal weight per book</option><option value="micro">Every book-day / raw sum</option><option value="calendar">Equal weight per calendar day</option><option value="completedOnly">Completed books only</option></select></label></div>
<p class="muted">All errors below cap remaining days at 90. Lower is better. Each model gets the same daily cases. Daily errors from the same book are correlated. The completed-only view conditions on eventual completion.</p><div class="table" id="leaderboard"></div>
<h2>Inspect a book's daily forecasts</h2><div class="controls"><label>Book<select id="book"></select></label><label>Model<select id="model"></select></label><label>Compare with<select id="baseline"></select></label></div>
<div class="legend"><span style="color:#17757c">Selected model</span><span style="color:#b16a22">Comparison model</span><span style="color:#59666a">Observed outcome</span><span>Shading: model's 10th to 90th quantiles</span></div>
<div id="chart"></div><p class="muted" id="booknote"></p><div class="pager"><button id="previous" type="button">Previous 40</button><span id="page"></span><button id="next" type="button">Next 40</button></div><div class="table" id="cases"></div>
<p class="muted">The chart caps values at 90. An unknown or later-than-90 prediction appears at the top for scoring; it does not mean the book is predicted to finish on day 90. Unfinished ground truth is shown at 90 only for cases with sufficient follow-up. Table predictions retain their original scale; calendar dates beyond one year are withheld. Point-only models have no uncertainty estimate. Their degenerate distributions are used only in the scoring files. Analogue quantiles and probabilities have not achieved reliable calibration. Unknown upper quantiles mean the data do not identify that endpoint. Dates are UTC.</p></main>
<script>const D=${payload};
const el=id=>document.getElementById(id),esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),num=x=>x===null?'Unknown':Number(x).toFixed(2),date=t=>new Date(t).toISOString().slice(0,10),cap=x=>Math.min(90,x===null?Infinity:x);let offset=0;
function options(id,items,value){el(id).innerHTML=items.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.title)+'</option>').join('');el(id).value=value;}
options('book',D.books.toSorted((a,b)=>a.title.localeCompare(b.title)),D.books.find(b=>b.title==='The Odyssey')?.id??D.books[0].id);options('model',D.names.map(id=>({id,title:id})),D.selected);options('baseline',D.names.map(id=>({id,title:id})),'blend-14');
function board(){const rank=el('ranking').value,scores=[...D.scores[el('period').value]].sort((a,b)=>(a[rank]??Infinity)-(b[rank]??Infinity));el('leaderboard').innerHTML='<table><thead><tr><th>Model</th><th>Mean per book</th><th>Median book</th><th>Mean per book-day</th><th>Summed daily error</th><th>Mean per calendar day</th><th>Completed only</th><th>Dates ≤1 year</th></tr></thead><tbody>'+scores.map(r=>'<tr class="'+(r.model===D.selected?'selected':'')+'"><td>'+esc(r.model)+'</td><td>'+num(r.macro)+'</td><td>'+num(r.medianBook)+'</td><td>'+num(r.micro)+'</td><td>'+num(r.sum)+'</td><td>'+num(r.calendar)+'</td><td>'+num(r.completedOnly)+'</td><td>'+Math.round(r.dateRate*100)+'%</td></tr>').join('')+'</tbody></table>';}
function render(){const rows=D.rows.filter(r=>r.book===el('book').value),mi=D.names.indexOf(el('model').value),bi=D.names.indexOf(el('baseline').value),w=1100,h=300,left=55,top=18,bottom=260,x=i=>left+(w-left-25)*i/Math.max(1,rows.length-1),y=v=>bottom-(bottom-top)*cap(v)/90;
const line=(fn,color,dash='')=>'<polyline fill="none" stroke="'+color+'" stroke-width="2" '+dash+' points="'+rows.map((r,i)=>fn(r)===undefined?'':x(i).toFixed(1)+','+y(fn(r)).toFixed(1)).join(' ')+'"/>';
const band=rows.map((r,i)=>x(i)+','+y(r.models[mi][1])).concat(rows.map((r,i)=>[r,i]).reverse().map(([r,i])=>x(i)+','+y(r.models[mi][2]))).join(' ');
let svg='<svg viewBox="0 0 '+w+' '+h+'" role="img" aria-label="Daily remaining-day forecasts compared with observed completion"><polygon points="'+band+'" fill="#17757c" opacity=".12"/>';
for(const v of [0,30,60,90])svg+='<line x1="'+left+'" x2="'+(w-25)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="#dae4e5"/><text x="5" y="'+(y(v)+4)+'" font-size="12" fill="#53676c">'+(v===90?'≥90':v)+' days</text>';
svg+=line(r=>r.actual===null?(r.mature?90:undefined):r.actual,'#59666a','stroke-dasharray="5 4"')+line(r=>r.models[bi][0],'#b16a22')+line(r=>r.models[mi][0],'#17757c');
for(const i of [...new Set([0,Math.floor((rows.length-1)/2),rows.length-1])])svg+='<text x="'+x(i)+'" y="287" text-anchor="'+(i===0?'start':i===rows.length-1?'end':'middle')+'" font-size="12" fill="#53676c">'+date(rows[i].at)+'</text>';
el('chart').innerHTML=svg+'</svg>';el('booknote').textContent=rows.length+' daily cases; '+rows.filter(r=>r.mature).length+' in the main score. Values are remaining calendar days, not active reading hours.';
offset=Math.min(offset,Math.floor((rows.length-1)/40)*40);el('page').textContent=(offset+1)+'–'+Math.min(offset+40,rows.length)+' of '+rows.length;el('previous').disabled=offset===0;el('next').disabled=offset+40>=rows.length;
el('cases').innerHTML='<table><thead><tr><th>Forecast date</th><th>Progress</th><th>Days idle</th><th>Reading minutes left</th><th>Model days left</th><th>Predicted finish</th><th>Comparison days</th><th>10th percentile days</th><th>90th percentile days</th><th>Finish within 30 days</th><th>Finish within 90 days</th><th>Actual days left</th><th>In 90-day score</th></tr></thead><tbody>'+rows.slice(offset,offset+40).map(r=>'<tr><td>'+date(r.at)+'</td><td>'+Math.round(r.progress*100)+'%</td><td>'+num(r.idle)+'</td><td>'+num(r.remaining)+'</td><td>'+num(r.models[mi][0])+'</td><td>'+(r.models[mi][0]===null?'No date':r.models[mi][0]>365?'Beyond 1 year':date(r.at+r.models[mi][0]*86400000))+'</td><td>'+num(r.models[bi][0])+'</td><td>'+(r.models[mi][8]?num(r.models[mi][1]):'Not modeled')+'</td><td>'+(r.models[mi][8]?num(r.models[mi][2]):'Not modeled')+'</td><td>'+(r.models[mi][8]?Math.round(r.models[mi][4]*100)+'%':'Not modeled')+'</td><td>'+(r.models[mi][8]?Math.round(r.models[mi][5]*100)+'%':'Not modeled')+'</td><td>'+num(r.actual)+'</td><td>'+(r.mature?'Yes':'Not enough follow-up')+'</td></tr>').join('')+'</tbody></table>';}
el('period').onchange=board;el('ranking').onchange=board;for(const id of ['book','model','baseline'])el(id).onchange=()=>{offset=0;render()};el('previous').onclick=()=>{offset-=40;render()};el('next').onclick=()=>{offset+=40;render()};board();render();
</script></html>`);
console.log(`Wrote ${directory}/report.md and report.html`);
