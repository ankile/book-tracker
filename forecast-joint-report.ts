// Produce private artifacts from a frozen experiment; no database access.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {snapshotBooks,type DailySnapshot} from './forecast-daily-data.ts';
import {actual,type evaluate} from './forecast-daily-score.ts';
import type {DailyPrediction} from './forecast-daily-models.ts';
import type {QueueConfig,QueueForecast} from './forecast-joint-model.ts';
const [file,email,directory]=process.argv.slice(2);
assert.ok(file&&email&&directory&&resolve(directory).startsWith(resolve('snapshots')+'/'));
const read=(name:string)=>JSON.parse(readFileSync(resolve(directory,name),'utf8'));
type Score=NonNullable<ReturnType<typeof evaluate>>;
type Attempt={config:QueueConfig;key:string;draws:number;reason:string;score:Score&{crps:number}};
const results=read('results.json') as {comparisons:Record<string,Score[]>;scores:Record<string,Record<string,Score&{crps:number}>>;configs:Record<string,QueueConfig>;selection:{selected:QueueConfig;scores:{config:QueueConfig;validation:Score&{crps:number}}[]};paired:Record<string,{baseline:string;improvement:number;bookInterval95:number[];calendarInterval95:number[]}[]>;subgroups:Record<string,Score[]>;sourceHash:string;codeHash:string};
const search=read('search.json') as {path:Attempt[];attempts:Attempt[];shortlist:Attempt[]},audit=read('audit.json'),manifest=read('manifest.json');
const snapshot:DailySnapshot=JSON.parse(readFileSync(file,'utf8')),asOf=Date.parse(snapshot.takenAt),books=snapshotBooks(snapshot,email);
const rows:DailyPrediction[]=readFileSync('snapshots/forecast-daily/predictions.jsonl','utf8').split('\n').map(line=>JSON.parse(line));
const index=new Map(rows.map(row=>[`${row.row.at}:${row.row.bookId}`,row]));
const names=[...Object.keys(results.scores),'blend-14-ungated','median-windows','ewma-7','simulation-30','blend-14','existing-30'];
for(const name of Object.keys(results.scores))for(const line of readFileSync(resolve(directory,name+'.jsonl'),'utf8').split('\n')){
  const row=JSON.parse(line) as DailyPrediction&{models:Record<string,QueueForecast>};
  const d=row.models[name];index.get(`${row.row.at}:${row.row.bookId}`)!.models[name]={days:d.days,lower:d.lower,upper:d.upper,cdf:d.cdf,support:d.support};
}
const n=(x:number)=>x.toFixed(2),pct=(x:number)=>(100*x).toFixed(1)+'%';
const selected=results.scores['joint-selected'],simple=results.scores['joint-simple'];
const table=(scores:Score[])=>'| Model | Mean book error | Median book error | Mean daily error | Daily error sum |\n|---|---:|---:|---:|---:|\n'+scores.map(s=>`| ${s.model} | ${n(s.macro)} | ${n(s.medianBook)} | ${n(s.micro)} | ${n(s.sum)} |`).join('\n');
const differences=(a:QueueConfig,b:QueueConfig)=>Object.entries(b).filter(([k,v])=>v!==a[k as keyof QueueConfig]).map(([k,v])=>`${k}=${v}`).join(', ');
const trajectory=search.path.map((row,i)=>({step:i,change:i?differences(search.path[i-1].config,row.config):'Simple shared queue',mae:row.score.macro,crps:row.score.crps}));
const rangeTable=(items:{name:string;intervalScore:number;coverage:number;width:number}[])=>'| Model | Interval score | Coverage | Width in days |\n|---|---:|---:|---:|\n'+items.map(x=>`| ${x.name} | ${n(x.intervalScore)} | ${pct(x.coverage)} | ${n(x.width)} |`).join('\n');
const paired=results.paired.all.find(row=>row.baseline==='joint-simple')!;
const c=results.selection.selected;
const markdown=`# Joint reading simulations

Snapshot ${snapshot.takenAt}. The experiment uses ${manifest.origins} daily origins and ${manifest.cases} book-day forecasts. The main score uses ${selected.all.bookDays} mature cases across ${selected.all.books} books. All work reads the existing local snapshot; no production or emulator access occurs.

## Result

Hill climbing improved the simple simulator's full-history mean book error from ${n(simple.all.macro)} to ${n(selected.all.macro)} days, a ${pct((simple.all.macro-selected.all.macro)/simple.all.macro)} reduction. The paired 95% book-resampling interval for improvement is ${paired.bookInterval95.map(n).join(' to ')} days; the calendar-block interval is ${paired.calendarInterval95.map(n).join(' to ')}. These intervals describe reused historical data after model selection, not an independent prospective experiment.

The tuned simulator has not beaten the strongest simple pace formulas. On the 2025 onward reused evaluation period it scores ${n(selected.recent.macro)} days versus ${n(results.comparisons.recent.find(x=>x.model==='blend-14-ungated')!.macro)} for the ungated 14-day formula. Its nominal 80% intervals also under-cover. It should remain a research model.

## Shared simulated futures

Each path samples one daily reading budget and allocates it across the complete reconstructed open queue. Reading advances a book, finishing it frees capacity, and leftover minutes can go to another book on that same day. All target books share the same path. Models cannot create reading time to meet independent deadlines.

The selected configuration samples daily budgets from the previous ${c.budgetWindow} days. Attention is based on each book's ${c.attentionWindow}-day reading rate, adjusted for its age and raised to power ${c.sharePower}. A book becomes paused after ${c.pauseAfter} days of inactivity. Historical return frequencies by inactivity group determine when it becomes eligible again. Those frequencies use only observations available at each monthly fitting cutoff. Paused states and simulated returns are modeling assumptions, not explicit user-supplied hold labels.

The experiment also tested consecutive-day budget blocks, preference for the last book, feedback from simulated reading, smaller session chunks, and synthetic new-book arrivals. The selected model disables those additions. Arrival-enabled candidates sample both arrival frequency and completed-book workloads from past visible history. Actual future books, sessions, and finishes never enter a simulation.

## Hill-climbing record

The extended search evaluated ${search.attempts.length} configuration/resolution pairs spanning ${new Set(search.attempts.map(row=>row.key)).size} unique configurations. A preserved preliminary four-round search informed extension of the search bounds before any 2024 validation scores were opened. Development uses pre-2024 origins with 90-day follow-up before January 2024.

| Accepted step | Change | Mean book error | CRPS |
|---|---|---:|---:|
${trajectory.map(row=>`| ${row.step} | ${row.change} | ${n(row.mae)} | ${n(row.crps)} |`).join('\n')}

Neighbors are screened with 32 paths and promising candidates confirmed with 128. Every neighbor of the final accepted configuration was checked with 128 paths. The search stopped because no neighbor improved the score by at least 0.02 days. It reached a local stopping point within this parameter grid. It did not exhaust all possible models.

${search.shortlist.length} candidates were shortlisted, including candidates with good distribution scores. The 2024 validation comparison used 256 paths and selected a ${c.pauseAfter}-day pause threshold. Configuration selection was frozen before opening the new later-period results. A later code audit found a floating-point completion bug; the unchanged search and validation procedure were rerun after the repair. Pre-fix outputs are preserved. The code hashes and rejected attempts are retained in the experiment folder.

## Scores

Errors are absolute differences in remaining calendar days, with both prediction and outcome capped at 90. Unresolved forecasts are scored as predicting 90 or more days. Only origins with 90 days of follow-up enter this score, regardless of whether the book eventually finished. Mean book error gives each book equal weight; the raw daily sum gives each book-day equal weight.

${table(results.comparisons.all)}

### 2025 onward

${table(results.comparisons.recent)}

The prior experiment already inspected this later period. Its repeated use limits significance claims. Full-history summaries also include development and validation data.

## Distribution quality

Empirical CRPS measures the entire simulated distribution of remaining days capped at 90. Lower is better. It falls from ${n(simple.all.crps)} to ${n(selected.all.crps)} over the full history, and from ${n(simple.recent.crps)} to ${n(selected.recent.crps)} in the later period. This distribution improvement coexists with worse later-period median predictions. Point forecasts' CRPS equals their absolute error, so beating them on CRPS alone is not evidence that the simulations have calibrated uncertainty.

The following interval comparison uses the same ${audit.ranges.all[0].cases} mature cases on which the current app can provide its historical range. All endpoints and outcomes are capped at 90. Coverage is book-weighted. The interval score penalizes both width and misses.

${rangeTable(audit.ranges.all)}

### Matched interval scores from 2025 onward

${rangeTable(audit.ranges.recent)}

The app range remains better on the matched interval score. Simulated 10th-to-90th percentiles are model quantiles, not validated 80% guarantees. Initial remaining reading time is currently fixed at its prefix estimate; speed-estimation uncertainty is not simulated. Recent-budget resampling also cannot generate changes absent from the historical window.

## Pauses and parallel reading

${Object.entries(results.subgroups).map(([group,items])=>`${group}: `+items.filter(s=>['joint-selected','joint-simple','blend-14-ungated'].includes(s.model)).map(s=>`${s.model} ${n(s.macro)}`).join('; ')+` days, ${items[0].bookDays} cases / ${items[0].books} books.`).join('\n\n')}

The paused-book gain is useful evidence for further work, but a subgroup found after evaluation should not be used to claim that a newly assembled hybrid has passed validation. Currently unfinished books stay in the primary score; audit.json also removes just the Bible and dissertations book as a sensitivity check.

### Largest later-period regressions against the ungated 14-day formula

| Book | Scored days | Additional mean error |
|---|---:|---:|
${audit.topBookRegressions.slice(0,8).map((r:{title:string;cases:number;extraMeanError:number})=>`| ${r.title.replaceAll('|','/')} | ${r.cases} | ${n(r.extraMeanError)} |`).join('\n')}

## Verification and limits

The independent seed scores ${n(results.scores['joint-seed2'].all.macro)} full-history and ${n(results.scores['joint-seed2'].recent.macro)} later-period mean book error, versus ${n(selected.all.macro)} and ${n(selected.recent.macro)}. Monte Carlo variation does not explain the generalization gap.

The audit checked ${audit.checkedForecasts} final forecast distributions and ${audit.checkedForecasts*256} sampled completion times. A spaced sample of origins also verifies shared-budget conservation. Unit tests exercise capacity reuse, zero-reading days, unresolved tails, returns, arrivals, horizon-prefix consistency, CRPS against its direct pairwise formula, and future-data exclusion.

Current page counts are treated as fixed. Deleted records and earlier edits cannot be recovered. Forecasts begin after the first visible progress; books completed between daily cutoffs have no daily origin. Return frequencies are descriptive conditional frequencies, not a causal model of reading intent. The probability of resuming can change with book identity and life circumstances not represented here. The simulation's historical new-book arrival process is deliberately simple and was not retained by validation.

No app model, production database or deployment was changed. The next useful research direction is better state-dependent uncertainty and return modeling, judged against the ungated pace baseline and using a fresh recorded validation procedure. The current results do not justify automatically promoting the simulator.

Source SHA-256: ${results.sourceHash}

Model/runner code SHA-256: ${results.codeHash}

## References

- [Block bootstrap for dependent time series](https://otexts.com/fpp3/bootstrap.html)
- [CRPS for ensemble forecasts](https://scoringrules.readthedocs.io/en/latest/generated/scoringrules.crps_ensemble.html)
- [Empirical and fair ensemble scoring](https://scoringrules.readthedocs.io/en/latest/crps_estimators.html)
`;
writeFileSync(resolve(directory,'report.md'),markdown);
writeFileSync(resolve(directory,'scores.csv'),'period,model,books,book_days,mean_book_error,median_book_error,mean_daily_error,sum_daily_error,crps\n'+Object.entries(results.comparisons).flatMap(([p,scores])=>scores.map(s=>[p,s.model,s.books,s.bookDays,s.macro,s.medianBook,s.micro,s.sum,results.scores[s.model]?.[p].crps??''].join(','))).join('\n'));
const payload=JSON.stringify({names,selected:'joint-selected',scores:results.comparisons,trajectory,search:search.attempts.map((row,i)=>({id:i+1,draws:row.draws,mae:row.score.macro,crps:row.score.crps,reason:row.reason,config:row.config})),
  books:books.filter(book=>rows.some(row=>row.row.bookId===book.id)).map(book=>({id:book.id,title:book.title})),
  rows:rows.map(item=>({at:item.row.at,book:item.row.bookId,idle:item.row.idle,progress:item.row.progress,remaining:item.row.remaining,mature:item.row.at<=asOf-90*86400000,actual:Number.isFinite(actual(item,asOf))?actual(item,asOf):null,
    models:names.map(name=>{const d=item.models[name];return [d.days,d.lower,d.upper,...d.cdf,d.support];})}))}).replaceAll('<','\\u003c');
writeFileSync(resolve(directory,'report.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Joint reading simulations</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f2f5f5;color:#213a40}main{max-width:1200px;margin:auto;padding:28px 22px}h1{font-size:32px;margin:8px 0}h2{font-size:22px;margin-top:32px}.muted{color:#516b70}a{color:#176b72}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card,.controls{background:white;border:1px solid #cedcdf;border-radius:8px;padding:16px}.card strong{display:block;font-size:26px}.notice{border-left:4px solid #a9793b;background:white;padding:16px}.controls{display:flex;gap:18px;flex-wrap:wrap}label{display:grid;gap:5px;min-width:180px;flex:1}select,button{font:inherit;border:1px solid #a3bfc3;border-radius:4px;padding:8px;background:white}button,select{cursor:pointer}button:focus-visible,select:focus-visible{outline:3px solid #247a81}.table{overflow:auto;max-height:430px;background:white;margin:14px 0}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:9px 11px;border-bottom:1px solid #dbe5e6;text-align:left;font-variant-numeric:tabular-nums}th{position:sticky;top:0;background:#e6eeee;white-space:nowrap}.chosen{background:#e1f1ef}svg{width:100%;height:auto;background:white;border:1px solid #cfdddf;border-radius:7px;margin:15px 0}.legend,.pager{display:flex;gap:18px;flex-wrap:wrap;font-size:13px}.config{font:12px/1.45 ui-monospace,monospace;min-width:500px}@media(max-width:700px){.cards{grid-template-columns:1fr 1fr}main{padding:16px 12px}h1{font-size:27px}}</style>
<main><p class="muted">Private local research · ${snapshot.takenAt.slice(0,10)} snapshot</p><h1>One reading budget, the whole queue</h1><p>Each simulated day advances competing books together. Finishing one book frees time for the others.</p>
<div class="cards"><div class="card"><strong>${new Set(search.attempts.map(row=>row.key)).size}</strong>distinct configurations searched</div><div class="card"><strong>${manifest.origins}</strong>daily queue states</div><div class="card"><strong>256</strong>shared futures per origin</div><div class="card"><strong>${selected.all.bookDays}</strong>cases in the 90-day score</div></div>
<p class="notice"><b>The simulator improved, but is not ready to replace the pace model.</b> Full-history mean book error fell from ${n(simple.all.macro)} to ${n(selected.all.macro)} days. In 2025 onward, the tuned simulation scores ${n(selected.recent.macro)} versus ${n(results.comparisons.recent.find(x=>x.model==='blend-14-ungated')!.macro)} for the simple 14-day formula. Simulated uncertainty still under-covers.</p>
<p><a href="report.md">Full findings and limitations</a> · <a href="scores.csv">All final scores</a> · <a href="audit.json">Audit results</a> · <a href="search.json">Complete search record</a></p>
<h2>Accepted development steps</h2><div class="table" id="path"></div><p class="muted">Only pre-2024 outcomes drove these steps. The 2024 validation shortlist selected a ${c.pauseAfter}-day pause threshold. The later period had been inspected in earlier experiments and is reused evaluation.</p>
<h2>Final comparisons</h2><div class="controls"><label>Period<select id="period"><option value="all">Full history</option><option value="recent">2025 onward</option></select></label><label>Sort by<select id="rank"><option value="macro">Equal weight per book</option><option value="micro">Raw sum / every book-day</option><option value="completedOnly">Completed books only</option></select></label></div><div class="table" id="scores"></div>
<p class="muted">Errors cap remaining time at 90 days. A missing date is scored as predicting 90 or more days. All models use the same mature cases. Daily error sums are unnormalized. Each book's many daily forecasts are correlated.</p>
<h2>Inspect daily predictions</h2><div class="controls"><label>Book<select id="book"></select></label><label>Model<select id="model"></select></label><label>Compare with<select id="compare"></select></label></div>
<p class="legend"><span style="color:#14757d">Model and 10th–90th percentile shading</span><span style="color:#ad742d">Comparison</span><span>Dashed gray: actual remaining time</span></p><div id="chart"></div><p class="muted" id="note"></p><div class="pager"><button id="previous">Previous 40</button><span id="page"></span><button id="next">Next 40</button></div><div class="table" id="days"></div>
<p class="muted">Quantiles and probabilities describe this simulation, not validated confidence. Point-only models have no uncertainty estimate. The chart caps values at 90; unknown endpoints appear there without implying a finish on day 90. Unfinished actual outcomes appear at 90 only after enough follow-up. Dates are UTC.</p>
<details><summary>Every search attempt, including rejected neighbors</summary><div class="table" id="attempts"></div></details></main>
<script>const D=${payload};const el=id=>document.getElementById(id),esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),num=x=>x===null?'Unknown':Number(x).toFixed(2),date=t=>new Date(t).toISOString().slice(0,10),cap=x=>Math.min(90,x===null?Infinity:x);let offset=0;
function table(head,rows){return '<table><thead><tr>'+head.map(x=>'<th>'+esc(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table>'}function cells(values){return values.map(x=>'<td>'+esc(x)+'</td>').join('')}
el('path').innerHTML=table(['Step','Change','Mean book error','CRPS'],D.trajectory.map(r=>'<tr>'+cells([r.step,r.change,num(r.mae),num(r.crps)])+'</tr>'));
el('attempts').innerHTML=table(['Attempt','Draws','Book error','CRPS','Reason','Configuration'],D.search.map(r=>'<tr>'+cells([r.id,r.draws,num(r.mae),num(r.crps),r.reason])+'<td class="config">'+esc(JSON.stringify(r.config))+'</td></tr>'));
function options(id,items,value){el(id).innerHTML=items.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.title)+'</option>').join('');el(id).value=value}options('book',D.books.toSorted((a,b)=>a.title.localeCompare(b.title)),D.books.find(b=>b.title==='The Odyssey')?.id??D.books[0].id);for(const id of ['model','compare'])options(id,D.names.map(id=>({id,title:id})),id==='model'?D.selected:'blend-14-ungated');
function board(){const key=el('rank').value;el('scores').innerHTML=table(['Model','Mean per book','Median book','Mean per day','Daily error sum','Completed only','Dates ≤1 year'],D.scores[el('period').value].toSorted((a,b)=>(a[key]??Infinity)-(b[key]??Infinity)).map(r=>'<tr class="'+(r.model===D.selected?'chosen':'')+'">'+cells([r.model,num(r.macro),num(r.medianBook),num(r.micro),num(r.sum),num(r.completedOnly),Math.round(r.dateRate*100)+'%'])+'</tr>'))}
function render(){const rows=D.rows.filter(r=>r.book===el('book').value),mi=D.names.indexOf(el('model').value),bi=D.names.indexOf(el('compare').value),x=i=>58+1010*i/Math.max(1,rows.length-1),y=v=>260-240*cap(v)/90;
const line=(fn,color,dash='')=>'<polyline fill="none" stroke="'+color+'" stroke-width="2" '+dash+' points="'+rows.map((r,i)=>fn(r)===undefined?'':x(i)+','+y(fn(r))).join(' ')+'"/>';
const band=rows.map((r,i)=>x(i)+','+y(r.models[mi][1])).concat(rows.map((r,i)=>[r,i]).reverse().map(([r,i])=>x(i)+','+y(r.models[mi][2]))).join(' ');
let svg='<svg viewBox="0 0 1100 300" role="img" aria-label="Daily simulated remaining time compared with actual completion"><polygon points="'+band+'" fill="#14757d" opacity=".12"/>';for(const v of [0,30,60,90])svg+='<line x1="58" x2="1068" y1="'+y(v)+'" y2="'+y(v)+'" stroke="#dde6e7"/><text x="3" y="'+(y(v)+4)+'" font-size="12">'+(v===90?'≥90':v)+' days</text>';
svg+=line(r=>r.actual===null?(r.mature?90:undefined):r.actual,'#62777b','stroke-dasharray="5 4"')+line(r=>r.models[bi][0],'#ad742d')+line(r=>r.models[mi][0],'#14757d');for(const i of [...new Set([0,Math.floor((rows.length-1)/2),rows.length-1])])svg+='<text x="'+x(i)+'" y="287" font-size="12" text-anchor="'+(i===0?'start':i===rows.length-1?'end':'middle')+'">'+date(rows[i].at)+'</text>';el('chart').innerHTML=svg+'</svg>';
el('note').textContent=rows.length+' daily cases; '+rows.filter(r=>r.mature).length+' with 90-day follow-up. Values are calendar days remaining.';offset=Math.min(offset,Math.floor((rows.length-1)/40)*40);el('page').textContent=(offset+1)+'–'+Math.min(offset+40,rows.length)+' of '+rows.length;el('previous').disabled=offset===0;el('next').disabled=offset+40>=rows.length;
el('days').innerHTML=table(['Forecast date','Progress','Days idle','Reading min left','Median days','Finish date','10th percentile','90th percentile','Finish ≤30 days','Finish ≤90 days','Comparison days','Actual days','Scored'],rows.slice(offset,offset+40).map(r=>{const d=r.models[mi];return '<tr>'+cells([date(r.at),Math.round(r.progress*100)+'%',num(r.idle),num(r.remaining),num(d[0]),d[0]===null?'Unknown':d[0]>365?'Beyond 1 year':date(r.at+d[0]*86400000),d[8]?num(d[1]):'Not modeled',d[8]?num(d[2]):'Not modeled',d[8]?Math.round(d[4]*100)+'%':'Not modeled',d[8]?Math.round(d[5]*100)+'%':'Not modeled',num(r.models[bi][0]),num(r.actual),r.mature?'Yes':'Too recent'])+'</tr>'}));}
el('period').onchange=board;el('rank').onchange=board;for(const id of ['book','model','compare'])el(id).onchange=()=>{offset=0;render()};el('previous').onclick=()=>{offset-=40;render()};el('next').onclick=()=>{offset+=40;render()};board();render();</script></html>`);
console.log('Wrote private report.md, report.html and scores.csv');
