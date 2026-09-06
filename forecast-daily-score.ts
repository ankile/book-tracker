import { FORECAST_DAY_MS as DAY } from './src/lib/utils/finishForecast.ts';
import { forecastRandom, quantile } from './forecast-candidates.ts';
import { HORIZONS } from './forecast-daily-data.ts';
import { MODEL_NAMES, type DailyPrediction } from './forecast-daily-models.ts';
export const mean=(values: readonly number[])=>values.reduce((sum,value)=>sum+value,0)/values.length;
export const actual=(item: DailyPrediction,asOf:number)=>item.row.finishedAt!==null&&item.row.finishedAt<=asOf
  ? Math.max(0,(item.row.finishedAt-item.row.at)/DAY) : Infinity;
export const loss=(item:DailyPrediction,name:string,asOf:number,horizon=90)=>Math.abs(Math.min(horizon,item.models[name].days??Infinity)-Math.min(horizon,actual(item,asOf)));
export function grouped<T>(rows: readonly T[],key:(row:T)=>string,value:(row:T)=>number): Map<string,number[]> {
  const groups=new Map<string,number[]>();
  for(const row of rows){const k=key(row),values=groups.get(k)??[];values.push(value(row));groups.set(k,values);}
  return groups;
}
export function evaluate(rows: readonly DailyPrediction[], name:string,asOf:number,horizon=90) {
  const eligible=rows.filter(item=>item.row.at<=asOf-horizon*DAY);
  if(!eligible.length)return null;
  const losses=eligible.map(item=>loss(item,name,asOf,horizon));
  const books=grouped(eligible,item=>item.row.bookId,item=>loss(item,name,asOf,horizon));
  const bookErrors=[...books.values()].map(mean);
  const days=grouped(eligible,item=>String(item.row.at),item=>loss(item,name,asOf,horizon));
  const hi=HORIZONS.indexOf(horizon);
  const brier=mean([...grouped(eligible,item=>item.row.bookId,item=>{
    const probability=item.models[name].cdf[hi]; return (probability-Number(actual(item,asOf)<=horizon))**2;
  }).values()].map(mean));
  const completed=eligible.filter(item=>actual(item,asOf)<Infinity);
  const dated=completed.filter(item=>item.models[name].days!==null&&item.models[name].days!<=365);
  const uncapped=dated.map(item=>Math.abs(item.models[name].days!-actual(item,asOf)));
  const interval=eligible.map(item=>{
    const d=item.models[name],lo=Math.min(horizon,d.lower??Infinity),hi=Math.min(horizon,d.upper??Infinity),y=Math.min(horizon,actual(item,asOf));
    return {bookId:item.row.bookId,score:hi-lo+10*Math.max(0,lo-y)+10*Math.max(0,y-hi),covered:Number(y>=lo&&y<=hi),width:hi-lo};
  });
  return {model:name,books:books.size,bookDays:eligible.length,calendarDays:days.size,
    macro:mean(bookErrors),medianBook:quantile(bookErrors,.5),p90Book:quantile(bookErrors,.9),
    micro:mean(losses),sum:losses.reduce((s,v)=>s+v,0),calendar:mean([...days.values()].map(mean)),brier,
    dateRate:mean([...grouped(eligible,item=>item.row.bookId,item=>Number(item.models[name].days!==null&&item.models[name].days!<=365)).values()].map(mean)),
    completedOnly:completed.length?mean([...grouped(completed,item=>item.row.bookId,item=>loss(item,name,asOf,horizon)).values()].map(mean)):null,
    uncapped:uncapped.length?{mean:mean(uncapped),median:quantile(uncapped,.5),p90:quantile(uncapped,.9),count:uncapped.length,completed:completed.length}:null,
    intervalScore:mean([...grouped(interval,item=>item.bookId,item=>item.score).values()].map(mean)),
    coverage:mean([...grouped(interval,item=>item.bookId,item=>item.covered).values()].map(mean)),
    width:mean([...grouped(interval,item=>item.bookId,item=>item.width).values()].map(mean)),
  };
}
export function leaderboard(rows:readonly DailyPrediction[],asOf:number,names=MODEL_NAMES) {
  return names.map(name=>evaluate(rows,name,asOf)).filter(score=>score!==null).sort((a,b)=>a.macro-b.macro);
}

// A deployable selection procedure, distinct from hindsight's best fixed model.
export function annualPolicy(rows: DailyPrediction[],names=MODEL_NAMES.filter(name=>!name.startsWith('constant')&&name!=='always-later')) {
  const choices: {year:number;model:string;trainingBooks:number;trainingCases:number}[]=[];
  const years=[...new Set(rows.map(item=>new Date(item.row.at).getUTCFullYear()))].sort();
  for(const year of years){
    const at=Date.UTC(year,0,1);
    const training=rows.filter(item=>item.row.at>=at-730*DAY&&item.row.at<at);
    const scores=leaderboard(training,at,names);
    const selected=scores.length&&scores[0].books>=15?scores[0].model:'blend-14';
    choices.push({year,model:selected,trainingBooks:scores[0]?.books??0,trainingCases:scores[0]?.bookDays??0});
    for(const item of rows.filter(item=>new Date(item.row.at).getUTCFullYear()===year))item.models['annual-policy']=item.models[selected];
  }
  return choices;
}

export function pairedBootstrap(rows:readonly DailyPrediction[],candidate:string,baseline:string,asOf:number) {
  const eligible=rows.filter(item=>item.row.at<=asOf-90*DAY);
  const deltas=[...grouped(eligible,item=>item.row.bookId,item=>loss(item,baseline,asOf)-loss(item,candidate,asOf)).values()].map(mean);
  const random=forecastRandom(82543);
  const bookDraws=Array.from({length:2000},()=>mean(deltas.map(()=>deltas[Math.floor(random()*deltas.length)])));
  // Resample whole 90-day calendar blocks, retaining all books and days.
  // Recompute per-book means in every draw so this estimates the macro score.
  const blockIds=[...new Set(eligible.map(item=>Math.floor(item.row.at/(90*DAY))))];
  const blocks=blockIds.map(id=>{
    const group=grouped(eligible.filter(item=>Math.floor(item.row.at/(90*DAY))===id),item=>item.row.bookId,item=>loss(item,baseline,asOf)-loss(item,candidate,asOf));
    return [...group].map(([id,values])=>({id,sum:values.reduce((s,v)=>s+v,0),count:values.length}));
  });
  const blockDraws=Array.from({length:2000},()=>{
    const sampled=new Map<string,{sum:number;count:number}>();
    for(let i=0;i<blocks.length;i++)for(const row of blocks[Math.floor(random()*blocks.length)]){
      const previous=sampled.get(row.id)??{sum:0,count:0};previous.sum+=row.sum;previous.count+=row.count;sampled.set(row.id,previous);
    }
    return mean([...sampled.values()].map(row=>row.sum/row.count));
  });
  return {improvement:mean(deltas),books:deltas.length,calendarBlocks:blocks.length,
    bookInterval95:[quantile(bookDraws,.025),quantile(bookDraws,.975)],
    calendarInterval95:[quantile(blockDraws,.025),quantile(blockDraws,.975)]};
}
