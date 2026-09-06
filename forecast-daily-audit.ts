// Independent diagnostics of the frozen experiment. No tuning or DB access.
// node forecast-daily-audit.ts <snapshot.json> <email> <private-output-directory>
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {FORECAST_DAY_MS as DAY,calibrateForecast,FORECAST_RANGE_SCALE} from './src/lib/utils/finishForecast.ts';
import {forecastHistoryFromInput} from './src/lib/utils/forecastHistory.ts';
import {dailyReplay,snapshotBooks,type DailySnapshot} from './forecast-daily-data.ts';
import {predictDaily,MODEL_NAMES,type DailyPrediction} from './forecast-daily-models.ts';
import {evaluate,actual,mean,grouped,pairedBootstrap} from './forecast-daily-score.ts';
const [file,email,directory]=process.argv.slice(2);
assert.ok(file&&email&&directory&&resolve(directory).startsWith(resolve('snapshots')+'/'));
const snapshot:DailySnapshot=JSON.parse(readFileSync(file,'utf8'));
const manifest=JSON.parse(readFileSync(resolve(directory,'manifest.json'),'utf8'));
const selection=JSON.parse(readFileSync(resolve(directory,'selection.json'),'utf8'));
const asOf=Date.parse(snapshot.takenAt),histories=snapshotBooks(snapshot,email);
const rows:DailyPrediction[]=readFileSync(resolve(directory,'predictions.jsonl'),'utf8').split('\n').map(line=>JSON.parse(line));
const names=[selection.selected,'blend-14','blend-14-ungated','median-windows-gated','existing-30'];
const mature=rows.filter(item=>item.row.at<=asOf-90*DAY);
assert.equal(new Set(rows.map(item=>`${item.row.bookId}:${item.row.at}`)).size,rows.length,'Duplicate book-day');
for(const item of rows)for(const forecast of Object.values(item.models)){
  assert.ok(forecast.days===null||Number.isFinite(forecast.days)&&forecast.days>=0);
  assert.ok(forecast.cdf.every(p=>Number.isFinite(p)&&p>=0&&p<=1));
  assert.ok(forecast.cdf.every((p,i)=>!i||p>=forecast.cdf[i-1]));
  assert.ok((forecast.lower??Infinity)<=(forecast.days??Infinity)&&(forecast.days??Infinity)<=(forecast.upper??Infinity));
}
const scores=(items:DailyPrediction[])=>names.map(name=>evaluate(items,name,asOf));
const common=rows.filter(item=>names.slice(0,2).every(name=>item.models[name].days!==null&&item.models[name].days!<=365));
const deferralCosts=[7,14,30].map(cost=>({cost,models:names.map(name=>({name,error:mean([...grouped(mature,item=>item.row.bookId,item=>{
  const d=item.models[name].days;return d===null||d>365?cost:Math.abs(Math.min(90,d)-Math.min(90,actual(item,asOf)));
}).values()].map(mean))}))}));
const history=forecastHistoryFromInput({now:asOf,books:histories.map(book=>({id:book.id,pageCount:book.pageCount,currentPage:book.rows.at(-1)?.toPage??0,finished:book.finishedAt!==null,finishedAt:book.finishedAt})),
  updates:histories.flatMap(book=>book.rows.map(row=>({bookId:row.bookId,at:row.at,editedAt:row.editedAt,type:row.type,minutes:row.minutes,pages:row.pages,toPage:row.toPage})))});
const intervalRows=mature.flatMap(item=>{
  const point=item.models['blend-14'].days;
  if(point===null||point>365)return [];
  const calibration=calibrateForecast(history.filter(row=>row.bookId!==item.row.bookId),item.row.at,item.row.idle);
  if(calibration===null)return [];
  const lo=Math.min(point,Math.max(1,point)*calibration.lowerFactor/FORECAST_RANGE_SCALE);
  const hi=Math.max(point,Math.max(1,point)*calibration.upperFactor*FORECAST_RANGE_SCALE);
  return [{item,appLower:lo,appUpper:hi>365?Infinity:hi}];
});
function rangeScore(items:typeof intervalRows,name:string){
  if(!items.length)return null;
  const data=items.map(row=>{
    const d=row.item.models[name];
    const lo=Math.min(90,name==='app-range'?row.appLower:d.lower??Infinity),hi=Math.min(90,name==='app-range'?row.appUpper:d.upper??Infinity),y=Math.min(90,actual(row.item,asOf));
    return {bookId:row.item.row.bookId,loss:hi-lo+10*Math.max(0,lo-y)+10*Math.max(0,y-hi),coverage:Number(y>=lo&&y<=hi),width:hi-lo};
  });
  return {name,books:new Set(data.map(row=>row.bookId)).size,cases:data.length,
    intervalScore:mean([...grouped(data,row=>row.bookId,row=>row.loss).values()].map(mean)),
    coverage:mean([...grouped(data,row=>row.bookId,row=>row.coverage).values()].map(mean)),
    width:mean([...grouped(data,row=>row.bookId,row=>row.width).values()].map(mean))};
}
const rangeNames=['app-range',...MODEL_NAMES.filter(name=>name.startsWith('analogue'))];
const ranges={all:rangeNames.map(name=>rangeScore(intervalRows,name)),recent:rangeNames.map(name=>rangeScore(intervalRows.filter(row=>row.item.row.at>=Date.UTC(2025,0,1)),name))};
const phase=predictDaily(dailyReplay(histories,asOf,12));
writeFileSync(resolve(directory,'phase12-predictions.jsonl'),phase.map(row=>JSON.stringify(row)).join('\n'));
const audit={caseCount:rows.length,checkedPredictions:rows.length*manifest.models.length,
  withTwoReadingDays:scores(rows.filter(item=>item.row.readingDays>=2)),commonDates:scores(common),
  gateAblation:pairedBootstrap(rows,'median-windows','blend-14-ungated',asOf),
  deferralCosts,ranges,phase12:scores(phase),phase12Recent:scores(phase.filter(item=>item.row.at>=Date.UTC(2025,0,1))),
  completedRanking:MODEL_NAMES.map(name=>evaluate(rows.filter(item=>!item.row.currentUnfinished),name,asOf)).filter(row=>row!==null).sort((a,b)=>a.macro-b.macro),
  excludedNamedBooks:scores(rows.filter(item=>!histories.some(book=>book.id===item.row.bookId&&['Holy Bible','Successful Dissertations and Theses'].includes(book.title)))),
};
writeFileSync(resolve(directory,'audit.json'),JSON.stringify(audit,null,2));
console.log(JSON.stringify({checkedPredictions:audit.checkedPredictions,common:audit.commonDates.map(r=>({model:r!.model,mae:r!.macro,count:r!.bookDays})),gate:audit.gateAblation,
  phase12:audit.phase12.map(r=>({model:r!.model,mae:r!.macro})),ranges:ranges.all.filter(r=>r!.name==='app-range'||r!.name.includes('median-ratio'))},null,2));
