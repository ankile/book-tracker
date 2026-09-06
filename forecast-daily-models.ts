import { FORECAST_DAY_MS as DAY } from './src/lib/utils/finishForecast.ts';
import { FORECAST_CANDIDATES } from './forecast-candidates.ts';
import { HORIZONS, type DailyCase } from './forecast-daily-data.ts';

export interface Distribution { days: number | null; lower: number | null; upper: number | null; cdf: number[]; support: number }
export interface SurvivalValue { time: number; event: boolean; weight: number }
export interface AnalogueModel { name: string; neighbors: number; kind: 'context' | 'pace' | 'pause' | 'ratio' | 'median-ratio'; recent: boolean }
export const ANALOGUE_MODELS: AnalogueModel[] = [12,24,48].flatMap((neighbors) => ['context','pace','pause','ratio','median-ratio'].map((kind) => ({
  name: `analogue-${kind}-${neighbors}`, neighbors, kind: kind as AnalogueModel['kind'], recent: false,
})));
export const RATE_MODELS = ['always-later','constant-7','constant-30', 'ewma-7','ewma-14','ewma-30',
  'budget-14','budget-30','regularized-14','regularized-30','median-windows','resume-decay-7','resume-decay-14',
  'blend-14-ungated','median-windows-gated','budget-14-gated','state-window'];
export const MODEL_NAMES = [...FORECAST_CANDIDATES.map((row) => row.name), ...RATE_MODELS, ...ANALOGUE_MODELS.map((row) => row.name)];
export const asFinite = (value: number) => Number.isFinite(value) ? value : null;
export const point = (days: number | null): Distribution => ({days, lower: days, upper: days,
  cdf: HORIZONS.map((h) => Number(days !== null && days <= h)), support: 0});

export function survivalDistribution(samples: readonly SurvivalValue[]): Distribution {
  const values = [...samples].sort((a,b) => a.time - b.time);
  let risk = values.reduce((total, row) => total + row.weight, 0), survival = 1;
  let lower: number | null = null, days: number | null = null, upper: number | null = null;
  const steps: {time: number; probability: number}[] = [];
  for (let i=0; i<values.length;) {
    const time = values[i].time;
    let j=i, removed=0, events=0;
    while (j<values.length && values[j].time === time) {
      removed += values[j].weight;
      if (values[j].event) events += values[j].weight;
      j++;
    }
    survival *= Math.max(0, 1-events/risk);
    const probability=1-survival;
    steps.push({time, probability});
    if (lower === null && probability >= .1 - 1e-12) lower=time;
    if (days === null && probability >= .5 - 1e-12) days=time;
    if (upper === null && probability >= .9 - 1e-12) upper=time;
    risk -= removed; i=j;
  }
  return {lower, days, upper, support: samples.length,
    cdf: HORIZONS.map(h=>steps.findLast(row=>row.time<=h)?.probability ?? 0)};
}

export function ratePredictions(row: DailyCase): Record<string, Distribution> {
  const result = Object.fromEntries(Object.entries(row.original).map(([name, value]) => [name, point(value)]));
  result['always-later']=point(null); result['constant-7']=point(7); result['constant-30']=point(30);
  for (const [i, half] of [7,14,30].entries()) result[`ewma-${half}`]=point(asFinite(row.remaining / row.ewma[i]));
  for (const [index, window] of [[1,14],[2,30]]) {
    const user=row.userRates[index], own=row.bookRates[index];
    result[`budget-${window}`]=point(asFinite(row.remaining / Math.min(user, Math.sqrt(user*own))));
    const exposure=Math.min(window,row.age), prior=user/Math.max(1,row.activeBooks);
    const daily=Math.min(user,(own*exposure+3*prior)/(exposure+3));
    result[`regularized-${window}`]=point(asFinite(row.remaining/daily));
  }
  const windows=row.bookRates.slice(0,4).map((book,i)=>row.remaining/Math.sqrt(book*row.userRates[i])).sort((a,b)=>a-b);
  result['median-windows']=point(asFinite((windows[1]+windows[2])/2));
  result['blend-14-ungated']=point(asFinite(row.remaining/Math.sqrt(row.bookRates[1]*row.userRates[1])));
  result['median-windows-gated']=row.readingDays>=2 ? result['median-windows'] : point(null);
  result['budget-14-gated']=row.readingDays>=2 ? result['budget-14'] : point(null);
  result['state-window']=row.idle<=7 ? result['median-windows'] : result['budget-30'];
  for (const half of [7,14]) result[`resume-decay-${half}`]=point(asFinite(row.remaining/(row.resumeRate*2**(-row.idle/half))));
  return result;
}

export function analoguePrediction(row: DailyCase, landmarks: readonly DailyCase[], trainingAt: number, model: AnalogueModel): Distribution {
  // One closest past state per OTHER book. Hundreds of nearly identical
  // landmarks from a long-open book must not become hundreds of neighbours.
  const best = new Map<string, {row: DailyCase; distance: number}>();
  const weights = model.kind === 'pause' ? [1,4,.2,.3,.2,.5,.2]
    : model.kind === 'pace' ? [2,1,0,0,0,2,0] : [1,1,.3,.5,.3,.5,.3];
  for (const other of landmarks) {
    if (other.at >= trainingAt || other.bookId === row.bookId) continue;
    if (model.recent && trainingAt-other.at>730*DAY) continue;
    const distance=other.vector.reduce((total,value,i)=>total+weights[i]*(value-row.vector[i])**2,0);
    if (!best.has(other.bookId) || distance<best.get(other.bookId)!.distance) best.set(other.bookId,{row:other,distance});
  }
  const nearest=[...best.values()].sort((a,b)=>a.distance-b.distance).slice(0,model.neighbors);
  if (nearest.length<4) return point(row.original['blend-14']);
  const base = (item: DailyCase) => Math.max(1,(model.kind==='median-ratio' ? ratePredictions(item)['median-windows'].days : item.original['blend-14'])
    ?? item.remaining/Math.max(.1,item.resumeRate));
  const samples=nearest.map(({row:other,distance}): SurvivalValue => {
    const event=other.finishedAt!==null && other.finishedAt<=trainingAt;
    const elapsed=Math.max(0,((event ? other.finishedAt! : trainingAt)-other.at)/DAY);
    return {time:model.kind === 'ratio' || model.kind === 'median-ratio' ? elapsed/base(other)*base(row) : elapsed, event,
      weight: Math.exp(-Math.sqrt(distance))};
  });
  return survivalDistribution(samples);
}

export interface DailyPrediction { row: DailyCase; models: Record<string, Distribution> }
export function predictDaily(cases: readonly DailyCase[], progress?: (at: number) => void): DailyPrediction[] {
  const landmarks=cases.filter(row=>Math.round(row.at/DAY)%7===0);
  let lastMonth=-1;
  let training: DailyCase[]=[];
  let trainingAt=0;
  return cases.map(row=>{
    const d=new Date(row.at), month=d.getUTCFullYear()*12+d.getUTCMonth();
    if (month!==lastMonth) {
      trainingAt=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1);
      training=landmarks.filter(other=>other.at<trainingAt);
      lastMonth=month; progress?.(row.at);
    }
    const models=ratePredictions(row);
    for (const model of ANALOGUE_MODELS) models[model.name]=analoguePrediction(row,training,trainingAt,model);
    return {row,models};
  });
}
