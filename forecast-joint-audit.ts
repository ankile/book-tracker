// Validate frozen simulations and compare uncertainty on the app's same cases.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {FORECAST_DAY_MS as DAY,calibrateForecast,FORECAST_RANGE_SCALE} from './src/lib/utils/finishForecast.ts';
import {forecastHistoryFromInput} from './src/lib/utils/forecastHistory.ts';
import {snapshotBooks,type DailySnapshot} from './forecast-daily-data.ts';
import type {DailyPrediction} from './forecast-daily-models.ts';
import {actual,evaluate,mean,grouped,loss} from './forecast-daily-score.ts';
import {empiricalCrps,simulateQueue,type QueueForecast,type SimulationAudit} from './forecast-joint-model.ts';
import type {QueueContext} from './forecast-joint-context.ts';
const [file,email,directory]=process.argv.slice(2);
assert.ok(file&&email&&directory&&resolve(directory).startsWith(resolve('snapshots')+'/'));
const raw=readFileSync(file,'utf8'),snapshot:DailySnapshot=JSON.parse(raw),asOf=Date.parse(snapshot.takenAt);
const results=JSON.parse(readFileSync(resolve(directory,'results.json'),'utf8'));
assert.equal(createHash('sha256').update(raw).digest('hex'),results.sourceHash);
const histories=snapshotBooks(snapshot,email),names=Object.keys(results.scores);
const originals:DailyPrediction[]=readFileSync('snapshots/forecast-daily/predictions.jsonl','utf8').split('\n').map(line=>JSON.parse(line));
const index=new Map(originals.map(row=>[`${row.row.at}:${row.row.bookId}`,row]));
let checked=0;
for(const name of names){
  const rows=readFileSync(resolve(directory,name+'.jsonl'),'utf8').split('\n').map(line=>JSON.parse(line)) as (DailyPrediction&{models:Record<string,QueueForecast>})[];
  assert.equal(rows.length,originals.length);assert.equal(new Set(rows.map(row=>`${row.row.at}:${row.row.bookId}`)).size,rows.length);
  for(const row of rows){
    const d=row.models[name];assert.equal(d.samples.length,256);
    assert.ok(d.samples.every(x=>x===null||Number.isFinite(x)&&x>=0&&x<=365));
    assert.ok(d.cdf.every((p,i)=>Number.isFinite(p)&&p>=0&&p<=1&&(!i||p>=d.cdf[i-1])));
    assert.ok((d.lower??Infinity)<=(d.days??Infinity)&&(d.days??Infinity)<=(d.upper??Infinity));
    index.get(`${row.row.at}:${row.row.bookId}`)!.models[name]=d;checked++;
  }
}
const contexts:QueueContext[]=JSON.parse(readFileSync(resolve(directory,'contexts.json'),'utf8'));
const resource:SimulationAudit={available:0,used:0,arrivals:0,completions:0,otherBooksCompletedFirst:0};
for(const c of contexts.filter((_,i)=>i%30===0)){
  const trace:SimulationAudit={available:0,used:0,arrivals:0,completions:0,otherBooksCompletedFirst:0};
  simulateQueue(c,results.selection.selected,16,365,7213,trace);
  assert.ok(trace.used<=trace.available+1e-7);for(const key of Object.keys(resource) as (keyof SimulationAudit)[])resource[key]+=trace[key];
}
const history=forecastHistoryFromInput({now:asOf,books:histories.map(book=>({id:book.id,pageCount:book.pageCount,currentPage:book.rows.at(-1)?.toPage??0,finished:book.finishedAt!==null,finishedAt:book.finishedAt})),updates:histories.flatMap(book=>book.rows.map(row=>({bookId:row.bookId,at:row.at,editedAt:row.editedAt,type:row.type,minutes:row.minutes,pages:row.pages,toPage:row.toPage})))});
const intervals=originals.filter(item=>item.row.at<=asOf-90*DAY).flatMap(item=>{
  const point=item.models['blend-14'].days;if(point===null||point>365)return [];
  const calibration=calibrateForecast(history.filter(row=>row.bookId!==item.row.bookId),item.row.at,item.row.idle);if(!calibration)return [];
  const lo=Math.min(point,Math.max(1,point)*calibration.lowerFactor/FORECAST_RANGE_SCALE),hi=Math.max(point,Math.max(1,point)*calibration.upperFactor*FORECAST_RANGE_SCALE);
  return [{item,lo,hi:hi>365?Infinity:hi}];
});
function rangeScore(rows:typeof intervals,name:string){
  const values=rows.map(({item,lo,hi})=>{
    const lower=Math.min(90,name==='app-range'?lo:item.models[name].lower??Infinity),upper=Math.min(90,name==='app-range'?hi:item.models[name].upper??Infinity),y=Math.min(90,actual(item,asOf));
    return {book:item.row.bookId,loss:upper-lower+10*Math.max(0,lower-y)+10*Math.max(0,y-upper),coverage:Number(y>=lower&&y<=upper),width:upper-lower};
  });
  return {name,cases:values.length,books:new Set(values.map(row=>row.book)).size,
    intervalScore:mean([...grouped(values,row=>row.book,row=>row.loss).values()].map(mean)),coverage:mean([...grouped(values,row=>row.book,row=>row.coverage).values()].map(mean)),width:mean([...grouped(values,row=>row.book,row=>row.width).values()].map(mean))};
}
const ranges=Object.fromEntries(Object.entries({all:intervals,recent:intervals.filter(row=>row.item.row.at>=Date.UTC(2025,0,1))}).map(([period,rows])=>[period,['app-range',...names].map(name=>rangeScore(rows,name))]));
const selectNames=['joint-selected','joint-simple','joint-development','joint-seed2','blend-14-ungated','median-windows','ewma-7'];
const common=originals.filter(row=>['joint-selected','blend-14-ungated'].every(name=>row.models[name].days!==null&&row.models[name].days!<=365));
const noNamed=originals.filter(row=>!histories.some(book=>book.id===row.row.bookId&&['Holy Bible','Successful Dissertations and Theses'].includes(book.title)));
const topBookRegressions=[...grouped(originals.filter(row=>row.row.at>=Date.UTC(2025,0,1)&&row.row.at<=asOf-90*DAY),row=>row.row.bookId,row=>loss(row,'joint-selected',asOf)-loss(row,'blend-14-ungated',asOf))].map(([id,values])=>({id,title:histories.find(book=>book.id===id)!.title,cases:values.length,extraMeanError:mean(values)})).sort((a,b)=>b.extraMeanError-a.extraMeanError);
const audit={topBookRegressions,checkedForecasts:checked,resource,ranges,commonDates:selectNames.map(name=>evaluate(common,name,asOf)),excludedNamed:selectNames.map(name=>evaluate(noNamed,name,asOf)),
  pointCrps:selectNames.filter(name=>!name.startsWith('joint')).map(name=>({name,crps:mean([...grouped(originals.filter(row=>row.row.at<=asOf-90*DAY),row=>row.row.bookId,row=>empiricalCrps([row.models[name].days],actual(row,asOf))).values()].map(mean))})),
  seedComparisons:{all:results.scores['joint-selected'].all.macro-results.scores['joint-seed2'].all.macro,recent:results.scores['joint-selected'].recent.macro-results.scores['joint-seed2'].recent.macro},
};
writeFileSync(resolve(directory,'audit.json'),JSON.stringify(audit,null,2));console.log(JSON.stringify(audit,null,2));
