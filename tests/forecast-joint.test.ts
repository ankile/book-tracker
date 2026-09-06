import assert from 'node:assert/strict';
import test from 'node:test';
import {SIMPLE_QUEUE,simulateQueue,empiricalCrps,type SimulationAudit} from '../forecast-joint-model.ts';
import {queueContexts,type QueueContext} from '../forecast-joint-context.ts';
import {dailyReplay,type DailyBook} from '../forecast-daily-data.ts';
const DAY=86400000,at=Date.UTC(2022,0,10);
const context:QueueContext={at,books:[{id:'a',remaining:6,idle:0,age:10,progress:.4,minutes:[10,10,10,10,10]},
  {id:'b',remaining:6,idle:0,age:10,progress:.4,minutes:[10,10,10,10,10]}],budgets:[10],lastBook:0,arrivalRate:0,workloads:[100],returnRates:Array(7).fill(0)};
const audit=():SimulationAudit=>({available:0,used:0,arrivals:0,completions:0,otherBooksCompletedFirst:0});
test('joint paths conserve minutes and carry freed time to the remaining book',()=>{
  const trace=audit(),predictions=simulateQueue(context,{...SIMPLE_QUEUE,stickiness:1},1,10,1,trace);
  assert.equal(predictions.a.days,.6);assert.equal(predictions.b.days,1.2);
  assert.equal(trace.used,12);assert.equal(trace.available,20);assert.equal(trace.completions,2);
  const alone=simulateQueue({...context,books:[context.books[1]],lastBook:0},SIMPLE_QUEUE,1,10,1);
  assert.equal(alone.b.days,.6);
});
test('zero budgets and dormant zero attention retain unresolved probability mass',()=>{
  assert.equal(simulateQueue({...context,budgets:[0]},SIMPLE_QUEUE,8,90).a.days,null);
  const dormant={...context,books:context.books.map(book=>({...book,minutes:[0,0,0,0,0]}))};
  assert.deepEqual(simulateQueue(dormant,SIMPLE_QUEUE,8,90).a.cdf,[0,0,0,0,0]);
});
test('rounding at completion cannot complete a book twice or stop the other books',()=>{
  const trace=audit(),c={...context,books:[{...context.books[0],remaining:10+1e-10},{...context.books[1],remaining:20}]};
  const result=simulateQueue(c,{...SIMPLE_QUEUE,stickiness:1},1,10,1,trace);
  assert.equal(result.a.days,1);assert.equal(result.b.days,3);assert.equal(trace.completions,2);
});
test('fixed seeds reproduce paths and longer horizons preserve the first 90 days',()=>{
  const c={...context,budgets:[0,1,0,3,0,2],books:context.books.map(book=>({...book,remaining:150}))};
  const first=simulateQueue(c,SIMPLE_QUEUE,32,90,94),long=simulateQueue(c,SIMPLE_QUEUE,32,365,94);
  assert.deepEqual(first,simulateQueue(c,SIMPLE_QUEUE,32,90,94));
  for(const id of ['a','b'])assert.deepEqual(first[id].samples.map(x=>Math.min(90,x??Infinity)),long[id].samples.map(x=>Math.min(90,x??Infinity)));
});
test('synthetic arrivals compete for time without consuming future book records',()=>{
  const trace=audit();
  const result=simulateQueue({...context,arrivalRate:1},{...SIMPLE_QUEUE,arrivalScale:1,stickiness:1},4,3,1,trace);
  assert.equal(trace.arrivals,12);assert.equal(trace.used,trace.available);assert.equal(result.a.days,null);
});
test('return model can reactivate dormant books and still conserves the shared budget',()=>{
  const trace=audit(),c={...context,returnRates:Array(7).fill(1),books:context.books.map(b=>({...b,idle:100,minutes:[0,0,0,0,0]}))};
  const result=simulateQueue(c,{...SIMPLE_QUEUE,pauseAfter:7,returnScale:1},16,10,1,trace);
  assert.ok(result.a.days!==null);assert.ok(trace.used<=trace.available);assert.equal(trace.completions,32);
});
test('empirical CRPS equals the direct pairwise formula, including censored tails',()=>{
  const samples=[1,3,8,null],values=[1,3,8,90],y=5;
  const absolute=values.reduce((s,x)=>s+Math.abs(x-y),0)/4;
  const spread=values.flatMap(x=>values.map(z=>Math.abs(x-z))).reduce((s,x)=>s+x,0)/32;
  assert.equal(empiricalCrps(samples,y),absolute-spread);
  assert.equal(empiricalCrps([3,3],5),2);assert.equal(empiricalCrps([null,null],Infinity),0);
});
test('future sessions, books, and completion metadata cannot change queue inputs',()=>{
  const book:DailyBook={id:'a',title:'A',pageCount:100,finishedAt:null,reliable:true,rows:[{bookId:'a',at:at-3*DAY,editedAt:at-3*DAY,type:'reading',minutes:10,pages:10,toPage:10}]};
  const cases=dailyReplay([book],at).filter(row=>row.at===at);
  const before=queueContexts([book],cases);
  const future={...book,finishedAt:at+DAY,rows:[...book.rows,{...book.rows[0],at:at+DAY,editedAt:at+DAY,toPage:100,pages:90}]};
  const futureBook={...future,id:'future',rows:[{...future.rows[1],bookId:'future'}]};
  assert.deepEqual(queueContexts([future,futureBook],cases),before);
  const changedLabels=cases.map(row=>({...row,finishedAt:at+99*DAY,currentUnfinished:false}));
  assert.deepEqual(queueContexts([book],changedLabels),before);
});
