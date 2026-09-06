// node forecast-daily.ts build|develop|validate|final <snapshot> <email> <private-output-dir>
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {FORECAST_DAY_MS as DAY} from './src/lib/utils/finishForecast.ts';
import {dailyReplay,snapshotBooks,HORIZONS,type DailySnapshot} from './forecast-daily-data.ts';
import {predictDaily,MODEL_NAMES,type DailyPrediction} from './forecast-daily-models.ts';
import {annualPolicy,evaluate,leaderboard,pairedBootstrap} from './forecast-daily-score.ts';

const [stage,file,email,directory]=process.argv.slice(2);
assert.ok(['build','develop','validate','final'].includes(stage)&&file&&email&&directory,'Expected stage, snapshot, email and output directory');
assert.ok(resolve(directory).startsWith(resolve('snapshots')+'/'),'Keep private results under ignored snapshots/');
mkdirSync(directory,{recursive:true});
const contents=readFileSync(file,'utf8'),snapshot:DailySnapshot=JSON.parse(contents),sourceHash=createHash('sha256').update(contents).digest('hex');
const asOf=Date.parse(snapshot.takenAt),developmentEnd=Date.UTC(2024,0,1),validationEnd=Date.UTC(2025,0,1);
const codeHash=createHash('sha256').update(['forecast-daily.ts','forecast-daily-data.ts','forecast-daily-models.ts','forecast-daily-score.ts','forecast-candidates.ts','src/lib/utils/finishForecast.ts'].map(path=>readFileSync(path,'utf8')).join('\n')).digest('hex');
const save=(name:string,value:unknown)=>writeFileSync(resolve(directory,name),JSON.stringify(value,null,2));
if(stage==='build'){
  const histories=snapshotBooks(snapshot,email);
  const started=Date.now();
  const cases=dailyReplay(histories,asOf);
  console.log(`Built ${cases.length} daily book cases in ${(Date.now()-started)/1000}s`);
  const rows=predictDaily(cases,at=>console.log(`Predicting ${new Date(at).toISOString().slice(0,7)}`));
  writeFileSync(resolve(directory,'predictions.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n'));
  save('manifest.json',{sourceHash,codeHash,asOf,models:MODEL_NAMES,phaseHours:0,cases:cases.length,calendarDays:new Set(cases.map(row=>row.at)).size,
    firstAt:cases[0].at,lastAt:cases.at(-1)!.at,books:histories.length,reconstructedBooks:new Set(cases.map(row=>row.bookId)).size,
    dailyCutoffs:Math.floor((cases.at(-1)!.at-cases[0].at)/DAY)+1,
    coldCases:cases.filter(row=>row.readingDays<2).length,dormantCases:cases.filter(row=>row.idle>30).length,
    noDailyForecast:histories.filter(book=>book.rows.length&&!cases.some(row=>row.bookId===book.id)).map(book=>({id:book.id,title:book.title})),
    noHistory:histories.filter(book=>!book.rows.length).map(book=>({id:book.id,title:book.title})),
    unreliable:histories.filter(book=>!book.reliable).map(book=>({id:book.id,title:book.title})),elapsedSeconds:(Date.now()-started)/1000});
  console.log('Replay and forecasts saved. No leaderboard for 2024 onward has been opened.');
}else{
  const manifest=JSON.parse(readFileSync(resolve(directory,'manifest.json'),'utf8'));
  assert.equal(manifest.sourceHash,sourceHash);assert.equal(manifest.codeHash,codeHash,'Rebuild predictions after changing model or scoring code');
  const rows:DailyPrediction[]=readFileSync(resolve(directory,'predictions.jsonl'),'utf8').split('\n').map(line=>JSON.parse(line));
  if(stage==='develop'){
    const board=leaderboard(rows.filter(item=>item.row.at<developmentEnd),developmentEnd);
    const shortlist=[...new Set([board[0].model,...board.filter(row=>row.model.startsWith('analogue')).slice(0,2).map(row=>row.model),...board.filter(row=>!row.model.startsWith('analogue')).slice(0,2).map(row=>row.model),'blend-14'])];
    save('development.json',{sourceHash,codeHash,shortlist,board});
    console.log(JSON.stringify({shortlist,leaders:board.slice(0,12).map(row=>({model:row.model,mae:row.macro,median:row.medianBook,micro:row.micro,brier90:row.brier}))},null,2));
  }else if(stage==='validate'){
    const development=JSON.parse(readFileSync(resolve(directory,'development.json'),'utf8'));
    assert.equal(development.codeHash,codeHash);
    const board=leaderboard(rows.filter(item=>item.row.at>=developmentEnd&&item.row.at<validationEnd),validationEnd,development.shortlist);
    save('selection.json',{sourceHash,codeHash,selected:board[0].model,shortlist:development.shortlist,validation:board,frozenAt:new Date().toISOString()});
    console.log(JSON.stringify({selected:board[0].model,validation:board.map(row=>({model:row.model,mae:row.macro,median:row.medianBook,brier90:row.brier}))},null,2));
  }else{
    const selection=JSON.parse(readFileSync(resolve(directory,'selection.json'),'utf8'));
    assert.equal(selection.codeHash,codeHash);assert.equal(selection.sourceHash,sourceHash);
    const choices=annualPolicy(rows);
    const names=[...MODEL_NAMES,'annual-policy'];
    const chosen=[...new Set([selection.selected,'annual-policy','blend-14','existing-30','always-later'])];
    const periods={all:rows,recent:rows.filter(item=>item.row.at>=validationEnd)};
    const scores=Object.fromEntries(Object.entries(periods).map(([period,items])=>[period,leaderboard(items,asOf,names)]));
    const subgroups={active:rows.filter(item=>item.row.idle<=7),quiet:rows.filter(item=>item.row.idle>7&&item.row.idle<=30),dormant:rows.filter(item=>item.row.idle>30),
      veryDormant:rows.filter(item=>item.row.idle>365),parallel:rows.filter(item=>item.row.activeBooks>1),cold:rows.filter(item=>item.row.readingDays<2),
      completed:rows.filter(item=>!item.row.currentUnfinished),unfinished:rows.filter(item=>item.row.currentUnfinished)};
    const summary={selection,choices,scores,horizons:Object.fromEntries(HORIZONS.map(h=>[h,chosen.map(name=>evaluate(rows,name,asOf,h))])),
      subgroups:Object.fromEntries(Object.entries(subgroups).map(([key,items])=>[key,chosen.map(name=>evaluate(items,name,asOf))])),
      years:Object.fromEntries([...new Set(rows.map(item=>new Date(item.row.at).getUTCFullYear()))].map(year=>[year,chosen.map(name=>evaluate(rows.filter(item=>new Date(item.row.at).getUTCFullYear()===year),name,asOf))])),
      paired:{all:pairedBootstrap(rows,selection.selected,'blend-14',asOf),recent:pairedBootstrap(periods.recent,selection.selected,'blend-14',asOf)},
      topBookDayContributors:[...new Set(rows.map(item=>item.row.bookId))].map(id=>({id,title:snapshotBooks(snapshot,email).find(book=>book.id===id)!.title,count:rows.filter(item=>item.row.bookId===id).length})).sort((a,b)=>b.count-a.count).slice(0,12)};
    save('results.json',summary);
    writeFileSync(resolve(directory,'scores.csv'),'model,books,book_days,macro_mae90,micro_mae90,total_absolute_error,calendar_mae90,median_book_mae90,p90_book_mae90,brier90,interval_score90,coverage90,date_rate\n'+scores.all.map(r=>[r.model,r.books,r.bookDays,r.macro,r.micro,r.sum,r.calendar,r.medianBook,r.p90Book,r.brier,r.intervalScore,r.coverage,r.dateRate].join(',')).join('\n'));
    console.log(JSON.stringify({selected:selection.selected,all:scores.all.slice(0,10).map(r=>({model:r.model,mae:r.macro,micro:r.micro})),recent:scores.recent.slice(0,10).map(r=>({model:r.model,mae:r.macro,micro:r.micro})),paired:summary.paired,choices},null,2));
  }
}
