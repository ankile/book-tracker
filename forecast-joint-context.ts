import {FORECAST_DAY_MS as DAY} from './src/lib/utils/finishForecast.ts';
import type {DailyBook,DailyCase} from './forecast-daily-data.ts';

export interface QueueBook {
  id: string; remaining: number; idle: number; age: number; progress: number;
  minutes: number[];
}
export interface QueueContext {
  at: number; books: QueueBook[]; budgets: number[]; lastBook: number;
  arrivalRate: number; workloads: number[]; returnRates: number[];
}
export const QUEUE_WINDOWS=[7,14,30,60,90];
export const idleBin=(idle:number)=>[1,3,7,14,30,90,Infinity].findIndex(edge=>idle<=edge);

// Fit conditional return frequencies once per month, from observed book-days.
// The target's own *past* selections are legitimate training observations.
export function fitReturnRates(histories:readonly DailyBook[],cases:readonly DailyCase[],at:number):number[] {
  const ownDays=new Set<string>(),readingDays=new Set<number>();
  for(const book of histories)for(const row of book.rows){
    if(row.at>=at||row.editedAt>at||row.type!=='reading'||row.minutes<=0||row.pages<0)continue;
    const day=Math.floor(row.at/DAY);ownDays.add(`${book.id}:${day}`);readingDays.add(day);
  }
  const exposure=Array(7).fill(0) as number[],read=Array(7).fill(0) as number[];
  for(const row of cases){
    if(row.at+DAY>at||row.at<at-3*365*DAY||!readingDays.has(Math.floor(row.at/DAY)))continue;
    const bin=idleBin(row.idle);exposure[bin]++;read[bin]+=Number(ownDays.has(`${row.bookId}:${Math.floor(row.at/DAY)}`));
  }
  const prior=[.5,.3,.2,.1,.05,.02,.005];
  return exposure.map((n,i)=>(read[i]+20*prior[i])/(n+20));
}

export function queueContexts(histories:readonly DailyBook[],cases:readonly DailyCase[]):QueueContext[] {
  const groups=new Map<number,DailyCase[]>();
  for(const row of cases){const values=groups.get(row.at)??[];values.push(row);groups.set(row.at,values);}
  let month=-1,returnRates:number[]=[];
  return [...groups].map(([at,rows])=>{
    const d=new Date(at),currentMonth=d.getUTCFullYear()*12+d.getUTCMonth();
    if(currentMonth!==month){returnRates=fitReturnRates(histories,cases,Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1));month=currentMonth;}
    const visible=histories.map(book=>({book,rows:book.rows.filter(row=>row.at<at&&row.editedAt<=at)}));
    const sessions=visible.flatMap(item=>item.rows).filter(row=>row.type==='reading'&&row.minutes>0&&row.pages>=0).sort((a,b)=>a.at-b.at);
    const first=sessions[0].at;
    const historyDays=Math.max(1,Math.min(180,Math.ceil((at-first)/DAY)));
    const budgets=Array(historyDays).fill(0) as number[];
    for(const session of sessions){const index=historyDays-1-Math.floor((at-session.at)/DAY);if(index>=0&&index<historyDays)budgets[index]+=session.minutes;}
    const bookIds=rows.map(row=>row.bookId);
    const starts=visible.flatMap(item=>{const first=item.rows.find(row=>row.type==='reading'&&row.minutes>0&&row.pages>=0);return first?[first.at]:[];});
    const readingDays=new Set(sessions.filter(row=>row.at>=at-365*DAY).map(row=>Math.floor(row.at/DAY))).size;
    const startDays=new Set(starts.filter(t=>t>=at-365*DAY).map(t=>Math.floor(t/DAY))).size;
    const completed=visible.filter(item=>(item.rows.at(-1)?.toPage??0)>=item.book.pageCount);
    const workloads=completed.map(item=>item.rows.filter(row=>row.type==='reading'&&row.minutes>0&&row.pages>=0).reduce((sum,row)=>sum+row.minutes,0)).filter(minutes=>minutes>0);
    return {at,budgets,lastBook:bookIds.indexOf(sessions.at(-1)!.bookId),returnRates,
      arrivalRate:(startDays+1)/(readingDays+10),workloads:workloads.length?workloads:[600],
      books:rows.map(row=>({id:row.bookId,remaining:row.remaining,idle:row.idle,age:row.age,progress:row.progress,
        minutes:QUEUE_WINDOWS.map((w,i)=>row.bookRates[i]*Math.min(w,row.age))}))};
  });
}
