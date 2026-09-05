/// <reference lib="webworker" />
import { forecastHistoryFromInput, type ForecastHistoryInput } from './forecastHistory.ts';
import type { ForecastObservation } from './finishForecast.ts';

const scope = self as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<ForecastHistoryInput>) => {
  const history: ForecastObservation[] = forecastHistoryFromInput(event.data);
  scope.postMessage(history);
};
