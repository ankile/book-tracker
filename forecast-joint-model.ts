import assert from 'node:assert/strict';
import {forecastRandom,quantile} from './forecast-candidates.ts';
import {HORIZONS} from './forecast-daily-data.ts';
import type {Distribution} from './forecast-daily-models.ts';
import {idleBin,QUEUE_WINDOWS,type QueueContext} from './forecast-joint-context.ts';

export interface QueueConfig {
  budgetWindow:number; block:number; attentionWindow:number; sharePower:number;
  exposureAdjustment:boolean; stickiness:number; feedback:number;
  pauseAfter:number; returnScale:number; arrivalScale:number; chunk:number;
}
export const SIMPLE_QUEUE:QueueConfig={budgetWindow:30,block:1,attentionWindow:30,sharePower:1,
  exposureAdjustment:false,stickiness:0,feedback:0,pauseAfter:0,returnScale:0,arrivalScale:0,chunk:0};
export interface QueueForecast extends Distribution {samples:(number|null)[]}
export function empiricalForecast(samples:readonly number[]):QueueForecast {
  return {days:Number.isFinite(quantile(samples,.5))?quantile(samples,.5):null,
    lower:Number.isFinite(quantile(samples,.1))?quantile(samples,.1):null,
    upper:Number.isFinite(quantile(samples,.9))?quantile(samples,.9):null,
    cdf:HORIZONS.map(h=>samples.filter(x=>x<=h).length/samples.length),support:samples.length,
    samples:samples.map(x=>Number.isFinite(x)?x:null)};
}
export function empiricalCrps(samples:readonly (number|null)[],actual:number,horizon=90):number {
  const values=samples.map(x=>Math.min(horizon,x??Infinity)).sort((a,b)=>a-b),n=values.length,y=Math.min(horizon,actual);
  const absolute=values.reduce((sum,x)=>sum+Math.abs(x-y),0)/n;
  const spread=values.reduce((sum,x,i)=>sum+(2*i-n+1)*x,0)/(n*n);
  return absolute-spread;
}
export interface SimulationAudit {available:number;used:number;arrivals:number;completions:number;otherBooksCompletedFirst:number}

// A trajectory updates the entire queue, with one finite budget shared by all books.
// Input contexts contain no completion labels or future book/session records.
export function simulateQueue(context:QueueContext,config:QueueConfig,draws=128,horizon=90,seed=7213,
  audit?:SimulationAudit):Record<string,QueueForecast> {
  assert.ok(context.books.length&&context.budgets.length&&draws>0&&horizon>0);
  const windowIndex=QUEUE_WINDOWS.indexOf(config.attentionWindow);assert.ok(windowIndex>=0);
  const budgets=context.budgets.slice(-config.budgetWindow);
  const initialWeights=context.books.map(book=>{
    const exposure=config.exposureAdjustment?Math.min(config.attentionWindow,Math.max(1,book.age)):1;
    return (book.minutes[windowIndex]/exposure)**config.sharePower;
  });
  const typicalWeight=initialWeights.reduce((s,x)=>s+x,0)/Math.max(1,initialWeights.filter(x=>x>0).length);
  const output=context.books.map(()=>[] as number[]),originalCount=context.books.length;
  for(let draw=0;draw<draws;draw++){
    const drawSeed=(seed^Math.imul(Math.floor(context.at/86400000),2654435761)^Math.imul(draw+1,1597334677))>>>0;
    const budgetRandom=forecastRandom(drawSeed),choiceRandom=forecastRandom(drawSeed^0xa6b3912f),arrivalRandom=forecastRandom(drawSeed^0x9233feab),returnRandom=forecastRandom(drawSeed^0x725fab31);
    const remaining=context.books.map(book=>book.remaining),weights=[...initialWeights],idle=context.books.map(book=>book.idle);
    const finishes=Array(originalCount).fill(Infinity) as number[],paused=idle.map(days=>config.pauseAfter>0&&days>config.pauseAfter);
    let previous=context.lastBook,completedOriginal=0,blockStart=0;
    for(let day=0;day<horizon&&completedOriginal<originalCount;day++){
      if(day%config.block===0)blockStart=Math.floor(budgetRandom()*budgets.length);
      const budget=budgets[(blockStart+day%config.block)%budgets.length];
      if(audit)audit.available+=budget;
      for(let i=0;i<remaining.length;i++)if(remaining[i]>0){idle[i]++;if(config.feedback>0)weights[i]*=2**(-1/config.attentionWindow);}
      // Draw every day's arrival uniform even when this configuration disables arrivals.
      const arrival=arrivalRandom();
      if(budget<=0)continue;
      if(arrival<Math.min(1,context.arrivalRate*config.arrivalScale)){
        remaining.push(context.workloads[Math.floor(arrivalRandom()*context.workloads.length)]);
        weights.push(typicalWeight||1);idle.push(0);paused.push(false);previous=remaining.length-1;
        if(audit)audit.arrivals++;
      }
      if(config.pauseAfter>0)for(let i=0;i<remaining.length;i++)if(remaining[i]>0){
        if(idle[i]>config.pauseAfter)paused[i]=true;
        if(paused[i]&&returnRandom()<Math.min(1,config.returnScale*context.returnRates[idleBin(idle[i])])){
          paused[i]=false;idle[i]=0;weights[i]=Math.max(weights[i],typicalWeight||1);
        }
      }
      let available=budget;
      while(available>1e-9){
        let selected=-1;
        const keep=choiceRandom();
        if(previous>=0&&remaining[previous]>0&&!paused[previous]&&keep<config.stickiness)selected=previous;
        else{
          let total=0;for(let i=0;i<remaining.length;i++)if(remaining[i]>0&&!paused[i])total+=weights[i];
          if(total<=0)break;
          let threshold=choiceRandom()*total;
          for(let i=0;i<remaining.length;i++)if(remaining[i]>0&&!paused[i]&&weights[i]>0){threshold-=weights[i];if(threshold<=0){selected=i;break;}}
        }
        assert.ok(selected>=0);
        const consumed=Math.min(available,remaining[selected],config.chunk>0?config.chunk:Infinity);
        available-=consumed;remaining[selected]-=consumed;idle[selected]=0;
        if(config.feedback>0)weights[selected]+=config.feedback*consumed/(config.exposureAdjustment?config.attentionWindow:1);
        previous=selected;if(audit)audit.used+=consumed;
        if(remaining[selected]<=1e-9){
          remaining[selected]=0;
          if(selected<originalCount){finishes[selected]=day+(budget-available)/budget;completedOriginal++;}
          if(audit){audit.completions++;if(selected>0&&remaining[0]>0)audit.otherBooksCompletedFirst++;}
        }
      }
    }
    for(let i=0;i<originalCount;i++)output[i].push(finishes[i]);
  }
  return Object.fromEntries(context.books.map((book,i)=>[book.id,empiricalForecast(output[i])]));
}
