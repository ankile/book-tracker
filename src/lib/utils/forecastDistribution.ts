import type { ForecastCalibration } from './finishForecast.ts';

// Equal-width bins in log(1 + days) keep the entire finite tail visible.
// Heights are probability mass per bin, not density per linear day.
export function forecastHistogram(calibration: ForecastCalibration, predictedDays: number, count = 24) {
  const samples = calibration.distribution!;
  const scale = Math.max(1, predictedDays);
  const maxDays = Math.max(1, ...samples.map((sample) => sample.ratio * scale));
  const extent = Math.log1p(maxDays);
  const position = (days: number) => Math.log1p(days) / extent;
  const bins = Array.from({ length: count }, (_, index) => ({
    from: Math.expm1(index / count * extent), to: Math.expm1((index + 1) / count * extent), mass: 0,
  }));
  for (const sample of samples) bins[Math.min(count - 1, Math.floor(position(sample.ratio * scale) * count))].mass += sample.mass;
  const ticks = [0, 1, 7, 30, 90, 365, 3650].filter((days) => days < maxDays && position(days) < .87)
    .filter((days, index, values) => index === 0 || position(days) - position(values[index - 1]) > .12);
  return { bins, maxDays, position, ticks: [...ticks, maxDays],
    maxMass: Math.max(.01, calibration.unresolvedMass, ...bins.map((bin) => bin.mass)) };
}
