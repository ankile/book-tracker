import assert from 'node:assert/strict';
import test from 'node:test';
import {FORECAST_DAY_MS as DAY} from '../src/lib/utils/finishForecast.ts';
import {dailyReplay,replayDay,type DailyBook,type DailyCase} from '../forecast-daily-data.ts';
import {analoguePrediction,point,ratePredictions,survivalDistribution,type DailyPrediction} from '../forecast-daily-models.ts';
import {actual,evaluate,annualPolicy} from '../forecast-daily-score.ts';
const start=Date.UTC(2022,0,1);
const book:DailyBook={id:'a',title:'A',pageCount:100,finishedAt:null,reliable:true,rows:[
  {bookId:'a',at:start+DAY/2,editedAt:start+DAY/2,type:'reading',minutes:20,pages:20,toPage:20},
  {bookId:'a',at:start+2.5*DAY,editedAt:start+2.5*DAY,type:'reading',minutes:20,pages:20,toPage:40},
]};
const makeRow=(id:string,at:number,finish:number|null):DailyCase=>({...replayDay([book],start+4*DAY)[0],bookId:id,at,finishedAt:finish});

test('daily replay covers every quiet day, includes cold starts and keeps multi-year holds',()=>{
  const rows=dailyReplay([book],start+800*DAY);
  assert.equal(rows.length,800);
  assert.equal(rows[0].readingDays,1);
  assert.equal(rows.at(-1)!.idle,797.5);
  assert.equal(rows[0].original['blend-14'],null);
  assert.ok(rows[0].original['existing-30']!==null);
});
test('future sessions and final completion metadata cannot change a past feature or prediction',()=>{
  const at=start+4*DAY;
  const row=replayDay([book],at)[0];
  const future={...book,finishedAt:start+6*DAY,rows:[...book.rows,{...book.rows[0],at:start+6*DAY,editedAt:start+6*DAY,toPage:100,pages:60}]};
  const later=replayDay([future],at)[0];
  assert.deepEqual({...later,finishedAt:null,currentUnfinished:true},row);
  const edited={...book,rows:[book.rows[0],{...book.rows[1],editedAt:start+5*DAY,toPage:90}]};
  assert.equal(replayDay([edited],at)[0].progress,.2);
});
test('historical parallel-book state comes from prefix progress, not final finished status',()=>{
  const other={...book,id:'b',finishedAt:start+20*DAY,rows:book.rows.map(row=>({...row,bookId:'b'}))};
  assert.equal(replayDay([book,other],start+4*DAY)[0].activeBooks,2);
});
test('fixed mature cohorts exclude recent completions as well as recent unfinished cases',()=>{
  const asOf=start+200*DAY;
  const rows:DailyPrediction[]=[{row:makeRow('a',asOf-100*DAY,asOf-80*DAY),models:{m:point(10)}},
    {row:makeRow('b',asOf-100*DAY,null),models:{m:point(null)}},
    {row:makeRow('fast',asOf-5*DAY,asOf-DAY),models:{m:point(4)}}];
  const score=evaluate(rows,'m',asOf)!;
  assert.equal(score.bookDays,2);assert.equal(score.macro,5);assert.equal(score.sum,10);
  assert.equal(actual(rows[1],asOf),Infinity);
  assert.equal(score.brier,0);
});
test('macro, micro and calendar aggregation have their specified denominators',()=>{
  const rows:DailyPrediction[]=[0,1,1].map((day,i)=>({row:makeRow(i<2?'a':'b',start+day*DAY,start+(day+20)*DAY),models:{m:point(i<2?10:50)}}));
  const score=evaluate(rows,'m',start+200*DAY)!;
  assert.equal(score.macro,20);assert.equal(score.micro,50/3);assert.equal(score.medianBook,10);assert.equal(score.sum,50);
  assert.equal(score.calendar,15);
  assert.equal(score.calendarDays,2);
});
test('Kaplan-Meier retains censored mass and returns ordered quantiles and probabilities',()=>{
  const d=survivalDistribution([{time:5,event:true,weight:1},{time:10,event:true,weight:1},{time:30,event:false,weight:2}]);
  assert.equal(d.lower,5);assert.equal(d.days,10);assert.equal(d.upper,null);
  assert.deepEqual(d.cdf,[.25,.5,.5,.5,.5]);
  assert.equal(survivalDistribution([{time:20,event:false,weight:1}]).days,null);
});
test('analogue fits cannot learn future outcomes or train on the target book',()=>{
  const trainingAt=start+100*DAY,target=makeRow('target',trainingAt+DAY,null);
  const landmarks=Array.from({length:12},(_,i)=>makeRow(`b${i}`,trainingAt-30*DAY,trainingAt+DAY));
  const model={name:'test',neighbors:12,kind:'context' as const,recent:false};
  const before=analoguePrediction(target,landmarks,trainingAt,model);
  assert.equal(before.days,null);
  const changed=landmarks.map(row=>({...row,finishedAt:trainingAt+500*DAY}));
  assert.deepEqual(analoguePrediction(target,[...changed,{...target,at:trainingAt-DAY,finishedAt:trainingAt}],trainingAt,model),before);
  assert.equal(before.support,12);
});
test('annual selection uses labels observed before the year being predicted',()=>{
  const at=Date.UTC(2022,0,1);
  const rows:DailyPrediction[]=Array.from({length:15},(_,i)=>({row:makeRow(String(i),at-200*DAY,at-180*DAY),models:{a:point(20),b:point(80),'blend-14':point(14)}}));
  rows.push({row:makeRow('current',at+DAY,at+50*DAY),models:{a:point(20),b:point(49),'blend-14':point(14)}});
  const choices=annualPolicy(rows,['a','b']);
  assert.equal(choices.find(row=>row.year===2022)!.model,'a');
  assert.equal(rows.at(-1)!.models['annual-policy'].days,20);
  const cold=ratePredictions(rows.at(-1)!.row);assert.equal(cold['always-later'].days,null);
});
