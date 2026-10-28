/**
 * Quota history: what a pool held over time, how fast it drained, and where
 * it is heading.
 *
 * Pure functions over ledger samples. `now` is always passed in, so every
 * case is testable without a clock.
 */

import { HOUR_MS } from '@/utils/time/durations';
import type { PoolMember } from './pools';

export interface QuotaLedgerSample {
  at: number;
  auth: string;
  provider: string;
  window: string;
  /** Percent remaining, 0..100. */
  remaining: number;
  resets_at?: number | null;
}

export interface ChartPoint {
  at: number;
  /** Null marks a gap: no trustworthy value at this instant. */
  value: number | null;
}

/** Samples further apart than this are a gap, not a measurement. */
export const MAX_SAMPLE_GAP_MS = 2 * HOUR_MS;

/** A rise larger than rounding noise means the window reset. */
const RESET_RISE = 0.5;

const DEFAULT_PERIOD_HOURS = 168;

export interface SeriesFilter {
  provider: string;
  window: string;
  auths: readonly string[];
}

/** Samples of each credential in the filter, oldest first. */
export function seriesOf(
  samples: readonly QuotaLedgerSample[],
  filter: SeriesFilter
): Map<string, QuotaLedgerSample[]> {
  const wanted = new Set(filter.auths);
  const series = new Map<string, QuotaLedgerSample[]>();
  for (const sample of samples) {
    if (sample.provider !== filter.provider || sample.window !== filter.window) continue;
    if (!wanted.has(sample.auth)) continue;
    const list = series.get(sample.auth) ?? [];
    list.push(sample);
    series.set(sample.auth, list);
  }
  series.forEach((list) => list.sort((a, b) => a.at - b.at));
  return series;
}

/** A credential's remaining percent at `at`, or null when the history does not cover it. */
function valueAt(list: readonly QuotaLedgerSample[], at: number): number | null {
  let latest: QuotaLedgerSample | null = null;
  for (const sample of list) {
    if (sample.at > at) break;
    latest = sample;
  }
  if (!latest || at - latest.at > MAX_SAMPLE_GAP_MS) return null;
  if (typeof latest.resets_at === 'number' && latest.resets_at <= at) return 100;
  return latest.remaining;
}

/**
 * The pool's remaining percent at each step of [fromMs, toMs].
 *
 * A step is a gap unless every credential with history in the range has a
 * value there: a partial sum would draw a cliff that never happened.
 * Credentials without any history are left out entirely.
 */
export function poolHistory(
  samples: readonly QuotaLedgerSample[],
  filter: SeriesFilter,
  fromMs: number,
  toMs: number,
  stepMs: number
): ChartPoint[] {
  const series = [...seriesOf(samples, filter).values()].filter((list) =>
    list.some((sample) => sample.at >= fromMs - MAX_SAMPLE_GAP_MS && sample.at <= toMs)
  );
  const points: ChartPoint[] = [];
  for (let at = fromMs; at <= toMs; at += stepMs) {
    if (series.length === 0) {
      points.push({ at, value: null });
      continue;
    }
    let sum = 0;
    let complete = true;
    for (const list of series) {
      const value = valueAt(list, at);
      if (value === null) {
        complete = false;
        break;
      }
      sum += value;
    }
    points.push({ at, value: complete ? sum : null });
  }
  return points;
}

interface Consumption {
  fromMs: number;
  toMs: number;
  amount: number;
}

/** Spending between consecutive samples; resets and gaps contribute nothing. */
function consumptions(list: readonly QuotaLedgerSample[]): Consumption[] {
  const result: Consumption[] = [];
  for (let index = 1; index < list.length; index += 1) {
    const previous = list[index - 1];
    const current = list[index];
    if (current.at - previous.at > MAX_SAMPLE_GAP_MS) continue;
    if (current.remaining > previous.remaining + RESET_RISE) continue;
    const resetBetween = typeof previous.resets_at === 'number' && previous.resets_at <= current.at;
    if (resetBetween) continue;
    result.push({
      fromMs: previous.at,
      toMs: current.at,
      amount: Math.max(0, previous.remaining - current.remaining),
    });
  }
  return result;
}

/**
 * Pool drain in percent per hour, one point per bucket. Each interval's
 * spending is spread over the buckets it overlaps; a bucket that no interval
 * touches is a gap.
 */
export function drainRate(
  samples: readonly QuotaLedgerSample[],
  filter: SeriesFilter,
  fromMs: number,
  toMs: number,
  bucketMs: number
): ChartPoint[] {
  const bucketCount = Math.max(1, Math.ceil((toMs - fromMs) / bucketMs));
  const spent = new Array<number>(bucketCount).fill(0);
  const covered = new Array<boolean>(bucketCount).fill(false);

  for (const list of seriesOf(samples, filter).values()) {
    for (const interval of consumptions(list)) {
      const duration = interval.toMs - interval.fromMs;
      for (let index = 0; index < bucketCount; index += 1) {
        const start = fromMs + index * bucketMs;
        const overlap =
          Math.min(interval.toMs, start + bucketMs) - Math.max(interval.fromMs, start);
        if (overlap <= 0) continue;
        covered[index] = true;
        spent[index] += duration > 0 ? (interval.amount * overlap) / duration : interval.amount;
      }
    }
  }

  const bucketHours = bucketMs / HOUR_MS;
  return spent.map((amount, index) => ({
    at: fromMs + index * bucketMs + bucketMs / 2,
    value: covered[index] ? amount / bucketHours : null,
  }));
}

/**
 * Average pool drain over the trailing window, in percent per hour: all
 * spending divided by the time any credential was measured. Null until that
 * time reaches an hour, so a first pair of samples does not read as zero.
 */
export function averageDrain(
  samples: readonly QuotaLedgerSample[],
  filter: SeriesFilter,
  nowMs: number,
  windowMs: number
): number | null {
  const fromMs = nowMs - windowMs;
  const intervals = [...seriesOf(samples, filter).values()]
    .flatMap(consumptions)
    .map((interval) => clipInterval(interval, fromMs, nowMs))
    .filter((interval): interval is Consumption => interval !== null);
  const measuredMs = coveredMs(intervals);
  if (measuredMs < HOUR_MS) return null;
  const spent = intervals.reduce((sum, interval) => sum + interval.amount, 0);
  return spent / (measuredMs / HOUR_MS);
}

function clipInterval(interval: Consumption, fromMs: number, toMs: number): Consumption | null {
  const start = Math.max(interval.fromMs, fromMs);
  const end = Math.min(interval.toMs, toMs);
  if (end <= start) return null;
  const share = (end - start) / (interval.toMs - interval.fromMs);
  return { fromMs: start, toMs: end, amount: interval.amount * share };
}

function coveredMs(intervals: readonly Consumption[]): number {
  let total = 0;
  let reachedMs = -Infinity;
  for (const { fromMs, toMs } of [...intervals].sort((a, b) => a.fromMs - b.fromMs)) {
    const start = Math.max(fromMs, reachedMs);
    if (toMs > start) total += toMs - start;
    reachedMs = Math.max(reachedMs, toMs);
  }
  return total;
}

export interface PoolForecast {
  points: ChartPoint[];
  /** First instant the pool reaches zero inside the horizon. */
  emptyAtMs: number | null;
  nextReset: { at: number; gain: number } | null;
}

interface SimulatedMember {
  remaining: number;
  resetAtMs: number | null;
  periodMs: number;
}

/**
 * Project the pool forward at a constant drain.
 *
 * The proxy fills one credential at a time, starting with the one whose
 * window resets first, so the drain is taken from that credential until it is
 * empty. Each credential jumps back to 100% when its window resets and starts
 * a new window of the same length.
 */
export function forecastPool(
  members: readonly PoolMember[],
  drainPerHour: number,
  nowMs: number,
  horizonMs: number,
  stepMs: number
): PoolForecast {
  const simulated: SimulatedMember[] = members.map((member) => ({
    remaining: member.remaining,
    resetAtMs: member.resetAtMs,
    periodMs: (member.periodHours ?? DEFAULT_PERIOD_HOURS) * HOUR_MS,
  }));
  const total = () => simulated.reduce((sum, member) => sum + member.remaining, 0);
  const points: ChartPoint[] = [{ at: nowMs, value: total() }];
  let emptyAtMs: number | null = total() <= 0 ? nowMs : null;
  let nextReset: PoolForecast['nextReset'] = null;
  const drainPerStep = Math.max(0, drainPerHour) * (stepMs / HOUR_MS);

  for (let at = nowMs + stepMs; at <= nowMs + horizonMs; at += stepMs) {
    for (const member of simulated) {
      while (member.resetAtMs !== null && member.resetAtMs <= at) {
        const gain = 100 - member.remaining;
        const resetAt = Math.max(member.resetAtMs, nowMs);
        if (gain >= RESET_RISE && (nextReset === null || resetAt < nextReset.at)) {
          nextReset = { at: resetAt, gain };
        }
        member.remaining = 100;
        member.resetAtMs += member.periodMs;
      }
    }

    let drain = drainPerStep;
    const fillOrder = [...simulated].sort(
      (a, b) => (a.resetAtMs ?? Infinity) - (b.resetAtMs ?? Infinity)
    );
    for (const member of fillOrder) {
      if (drain <= 0) break;
      const taken = Math.min(member.remaining, drain);
      member.remaining -= taken;
      drain -= taken;
    }

    const value = total();
    if (emptyAtMs === null && value <= 0) emptyAtMs = at;
    points.push({ at, value });
  }

  return { points, emptyAtMs, nextReset };
}
