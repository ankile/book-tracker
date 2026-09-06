// Local research only. node forecast-joint.ts build|search|validate|final <snapshot> <email> <output>
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {FORECAST_DAY_MS as DAY} from './src/lib/utils/finishForecast.ts';
import {snapshotBooks,HORIZONS,type DailySnapshot,type DailyCase} from './forecast-daily-data.ts';
import {type DailyPrediction} from './forecast-daily-models.ts';
import {actual,evaluate,grouped,mean,pairedBootstrap} from './forecast-daily-score.ts';
import {queueContexts,type QueueContext} from './forecast-joint-context.ts';
import {SIMPLE_QUEUE,simulateQueue,empiricalCrps,type QueueConfig,type QueueForecast} from './forecast-joint-model.ts';

const [stage,file,email,directory]=process.argv.slice(2);
assert.ok(['build','search','validate','final'].includes(stage)&&file&&email&&directory);
assert.ok(resolve(directory).startsWith(resolve('snapshots')+'/'));mkdirSync(directory,{recursive:true});
const save=(name:string,value:unknown)=>writeFileSync(resolve(directory,name),JSON.stringify(value,null,2));
const read=(name:string)=>JSON.parse(readFileSync(resolve(directory,name),'utf8'));
const contents=readFileSync(file,'utf8'),snapshot:DailySnapshot=JSON.parse(contents),asOf=Date.parse(snapshot.takenAt);
const sourceHash=createHash('sha256').update(contents).digest('hex');
const codeHash=createHash('sha256').update(['forecast-joint.ts','forecast-joint-context.ts','forecast-joint-model.ts','forecast-daily-data.ts','forecast-daily-models.ts','forecast-daily-score.ts','forecast-candidates.ts','src/lib/utils/finishForecast.ts'].map(f=>readFileSync(f,'utf8')).join('\n')).digest('hex');
const original:DailyPrediction[]=readFileSync('snapshots/forecast-daily/predictions.jsonl','utf8').split('\n').map(line=>JSON.parse(line));
assert.equal(JSON.parse(readFileSync('snapshots/forecast-daily/manifest.json','utf8')).sourceHash,sourceHash);
const cases=original.map(item=>item.row),byKey=new Map(cases.map(row=>[`${row.at}:${row.bookId}`,row]));
const DEV=Date.UTC(2024,0,1),VALID=Date.UTC(2025,0,1);

type JointRow=DailyPrediction & {models:Record<string,QueueForecast>};
function predict(contexts:readonly QueueContext[],config:QueueConfig,draws:number,horizon:number,name='joint',seed=7213):JointRow[]{
  const out:JointRow[]=[];
  for(const context of contexts){
    const forecasts=simulateQueue(context,config,draws,horizon,seed);
    for(const [bookId,forecast]of Object.entries(forecasts))out.push({row:byKey.get(`${context.at}:${bookId}`)!,models:{[name]:forecast}});
  }
  return out;
}
function score(rows:readonly JointRow[],name:string,end:number){
  const ordinary=evaluate(rows,name,end)!;
  const eligible=rows.filter(item=>item.row.at<=end-90*DAY);
  return {...ordinary,crps:mean([...grouped(eligible,item=>item.row.bookId,item=>empiricalCrps(item.models[name].samples,actual(item,end))).values()].map(mean))};
}
type JointScore=ReturnType<typeof score>;
interface Attempt {config:QueueConfig;key:string;draws:number;score:JointScore;seconds:number;reason:string}

if(stage==='build'){
  const contexts=queueContexts(snapshotBooks(snapshot,email),cases);
  save('contexts.json',contexts);
  save('manifest.json',{sourceHash,codeHash,asOf,origins:contexts.length,cases:cases.length,seed:7213,developmentEnd:DEV,validationEnd:VALID});
  console.log(JSON.stringify({origins:contexts.length,cases:cases.length,first:contexts[0].at,last:contexts.at(-1)!.at}));
}else{
  const manifest=read('manifest.json');assert.equal(manifest.sourceHash,sourceHash);assert.equal(manifest.codeHash,codeHash,'Code changed; preserve previous run and rebuild');
  const contexts:QueueContext[]=read('contexts.json');
  if(stage==='search'){
    const development=contexts.filter(c=>c.at<=DEV-90*DAY);
    const attempts:Attempt[]=[],cache=new Map<string,Attempt>();
    const attempt=(config:QueueConfig,draws:number,reason:string)=>{
      const key=JSON.stringify(config),cacheKey=key+':'+draws;
      if(cache.has(cacheKey))return cache.get(cacheKey)!;
      const start=Date.now(),result={config,key,draws,score:score(predict(development,config,draws,90),'joint',DEV),seconds:(Date.now()-start)/1000,reason};
      attempts.push(result);cache.set(cacheKey,result);save('search-progress.json',{sourceHash,codeHash,attempts});
      console.log(JSON.stringify({attempt:attempts.length,draws,mae:result.score.macro,crps:result.score.crps,seconds:result.seconds,reason,config}));return result;
    };
    const dimensions:Record<keyof QueueConfig,number[]|boolean[]>={
      budgetWindow:[14,30,60,90,180],block:[1,3,7],attentionWindow:[7,14,30,60,90],sharePower:[.5,1,2,4],
      exposureAdjustment:[false,true],stickiness:[0,.5,.85],feedback:[0,.5,1],pauseAfter:[0,7,14,30,60],returnScale:[0,.5,1,2],arrivalScale:[0,.5,1],chunk:[0,30],
    };
    let current=attempt(SIMPLE_QUEUE,128,'simple baseline');
    const path=[current];
    for(let round=0;round<8;round++){
      const neighbors:QueueConfig[]=[];
      for(const [dimension,values]of Object.entries(dimensions))for(const value of values){
        if(current.config[dimension as keyof QueueConfig]===value)continue;
        const neighbor={...current.config,[dimension]:value};
        // Return rate has no effect when pauses are disabled. Enable together.
        if(dimension==='pauseAfter'&&Number(value)>0&&neighbor.returnScale===0)neighbor.returnScale=1;
        if(dimension==='returnScale'&&neighbor.pauseAfter===0)continue;
        neighbors.push(neighbor);
      }
      const coarse=neighbors.map(config=>attempt(config,32,`round ${round+1} neighbor`)).sort((a,b)=>a.score.macro-b.score.macro);
      let confirmed=coarse.slice(0,4).map(row=>attempt(row.config,128,`round ${round+1} confirmation`)).sort((a,b)=>a.score.macro-b.score.macro);
      if(confirmed[0].score.macro>=current.score.macro-.02)confirmed=coarse.map(row=>attempt(row.config,128,`round ${round+1} full neighborhood confirmation`)).sort((a,b)=>a.score.macro-b.score.macro);
      if(confirmed[0].score.macro>=current.score.macro-.02)break;
      current=confirmed[0];path.push(current);
    }
    const confirmed=attempts.filter(row=>row.draws===128).sort((a,b)=>a.score.macro-b.score.macro);
    const shortlist=[...new Map([current,...confirmed.slice(0,3),...confirmed.toSorted((a,b)=>a.score.crps-b.score.crps).slice(0,2),path[0]].map(row=>[row.key,row])).values()];
    save('search.json',{sourceHash,codeHash,attempts,path,shortlist,selected:current});
    console.log(JSON.stringify({searchComplete:true,attempts:attempts.length,path:path.map(row=>({mae:row.score.macro,crps:row.score.crps,config:row.config})),shortlist:shortlist.length}));
  }else if(stage==='validate'){
    const search=read('search.json') as {codeHash:string;shortlist:Attempt[]};assert.equal(search.codeHash,codeHash);
    const validation=contexts.filter(c=>c.at>=DEV&&c.at<=VALID-90*DAY);
    const scores=search.shortlist.map(row=>({config:row.config,development:row.score,validation:score(predict(validation,row.config,256,90),'joint',VALID)})).sort((a,b)=>a.validation.macro-b.validation.macro);
    save('selection.json',{sourceHash,codeHash,frozenAt:new Date().toISOString(),selected:scores[0].config,scores});
    console.log(JSON.stringify(scores.map(row=>({mae:row.validation.macro,crps:row.validation.crps,config:row.config})),null,2));
  }else{
    const selection=read('selection.json');assert.equal(selection.codeHash,codeHash);assert.equal(selection.sourceHash,sourceHash);
    const search=read('search.json');
    const configs:Record<string,QueueConfig>={'joint-simple':SIMPLE_QUEUE,'joint-selected':selection.selected,'joint-development':search.selected.config};
    const selected:QueueConfig=selection.selected;
    if(selected.stickiness>0)configs['joint-without-stickiness']={...selected,stickiness:0};
    if(selected.arrivalScale>0)configs['joint-without-arrivals']={...selected,arrivalScale:0};
    if(selected.feedback>0)configs['joint-without-feedback']={...selected,feedback:0};
    if(selected.pauseAfter>0)configs['joint-without-pauses']={...selected,pauseAfter:0};
    if(selected.block>1)configs['joint-without-blocks']={...selected,block:1};
    const ledger:DailyPrediction[]=original.map(item=>({row:item.row,models:{...item.models}}));
    const index=new Map(ledger.map(row=>[`${row.row.at}:${row.row.bookId}`,row]));
    const scores:Record<string,Record<string,JointScore>>={};
    for(const [name,config]of Object.entries(configs)){
      const start=Date.now(),predictions=predict(contexts,config,256,365,name);
      writeFileSync(resolve(directory,name+'.jsonl'),predictions.map(row=>JSON.stringify(row)).join('\n'));
      for(const row of predictions)index.get(`${row.row.at}:${row.row.bookId}`)!.models[name]=row.models[name];
      scores[name]={all:score(predictions,name,asOf),recent:score(predictions.filter(row=>row.row.at>=VALID),name,asOf)};
      console.log(JSON.stringify({name,seconds:(Date.now()-start)/1000,all:scores[name].all.macro,recent:scores[name].recent.macro,crps:scores[name].all.crps}));
    }
    const replicate=predict(contexts,selected,256,365,'joint-seed2',19307);
    writeFileSync(resolve(directory,'joint-seed2.jsonl'),replicate.map(row=>JSON.stringify(row)).join('\n'));
    for(const row of replicate)index.get(`${row.row.at}:${row.row.bookId}`)!.models['joint-seed2']=row.models['joint-seed2'];
    scores['joint-seed2']={all:score(replicate,'joint-seed2',asOf),recent:score(replicate.filter(row=>row.row.at>=VALID),'joint-seed2',asOf)};
    const names=[...Object.keys(scores),'blend-14-ungated','median-windows','ewma-7','simulation-30','blend-14','existing-30'];
    const periods={all:ledger,recent:ledger.filter(row=>row.row.at>=VALID)};
    const subgroups={active:ledger.filter(item=>item.row.idle<=7),quiet:ledger.filter(item=>item.row.idle>7&&item.row.idle<=30),dormant:ledger.filter(item=>item.row.idle>30),cold:ledger.filter(item=>item.row.readingDays<2),parallel:ledger.filter(item=>item.row.activeBooks>1),unfinished:ledger.filter(item=>item.row.currentUnfinished),completed:ledger.filter(item=>!item.row.currentUnfinished)};
    const report={sourceHash,codeHash,selection,configs,scores,comparisons:Object.fromEntries(Object.entries(periods).map(([p,rows])=>[p,names.map(name=>evaluate(rows,name,asOf))])),
      horizons:Object.fromEntries(HORIZONS.map(h=>[h,names.map(name=>evaluate(ledger,name,asOf,h))])),
      subgroups:Object.fromEntries(Object.entries(subgroups).map(([group,rows])=>[group,names.map(name=>evaluate(rows,name,asOf))])),
      paired:Object.fromEntries(Object.entries(periods).map(([p,rows])=>[p,['joint-simple','blend-14-ungated','median-windows','ewma-7'].map(baseline=>({baseline,...pairedBootstrap(rows,'joint-selected',baseline,asOf)}))]))};
    save('results.json',report);
    console.log('Final results saved; app predictor unchanged.');
  }
}
