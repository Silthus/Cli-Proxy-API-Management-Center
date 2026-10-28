/**
 * Axis ticks and time formats for the quota charts.
 */

import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import type { ChartTick } from './TimeChart';

const TICK_STEPS_MS = [HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS, DAY_MS, 2 * DAY_MS];
const MAX_X_TICKS = 6;

const firstLocalBoundary = (fromMs: number, stepMs: number) => {
  const date = new Date(fromMs);
  if (stepMs >= DAY_MS) {
    date.setHours(0, 0, 0, 0);
  } else {
    const stepHours = stepMs / HOUR_MS;
    date.setHours(Math.floor(date.getHours() / stepHours) * stepHours, 0, 0, 0);
  }
  let at = date.getTime();
  while (at < fromMs) at += stepMs;
  return at;
};

export const formatClock = (ms: number, locale?: string) =>
  new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });

export const formatDay = (ms: number, locale?: string) =>
  new Date(ms).toLocaleDateString(locale, { month: 'short', day: 'numeric' });

/** `Wed 10:01 AM` */
export const formatWeekdayClock = (ms: number, locale?: string) =>
  new Date(ms).toLocaleString(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** Evenly spaced time labels on local hour or day boundaries. */
export function timeTicks(fromMs: number, toMs: number, locale?: string): ChartTick[] {
  const span = toMs - fromMs;
  const stepMs =
    TICK_STEPS_MS.find((step) => span / step <= MAX_X_TICKS) ??
    TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
  const ticks: ChartTick[] = [];
  for (let at = firstLocalBoundary(fromMs, stepMs); at <= toMs; at += stepMs) {
    ticks.push({ at, label: stepMs >= DAY_MS ? formatDay(at, locale) : formatClock(at, locale) });
  }
  return ticks;
}

/** Quarter ticks of the pool capacity: 0, 175, 350, 525, 700 for seven credentials. */
export const capacityTicks = (capacity: number) =>
  [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
    const value = Math.round(capacity * fraction);
    return { value, label: `${value}%` };
  });

/** A ceiling for rates whose quarter ticks are whole numbers, never below 4. */
export function rateCeiling(peak: number): number {
  return Math.max(4, Math.ceil(peak / 4) * 4);
}

export const rateTicks = (ceiling: number) =>
  [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
    const value = ceiling * fraction;
    return { value, label: String(value) };
  });
