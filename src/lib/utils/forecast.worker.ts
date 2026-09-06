/// <reference lib="webworker" />
import { forecastHistoryFromInput, type ForecastHistoryInput } from './forecastHistory.ts';
import { forecastBacktest, type ForecastWorkerResult } from './forecastDiagnostics.ts';

const scope = self as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<ForecastHistoryInput>) => {
  const history = forecastHistoryFromInput(event.data);
  scope.postMessage({ history, backtest: forecastBacktest(history, event.data.now) } satisfies ForecastWorkerResult);
};
