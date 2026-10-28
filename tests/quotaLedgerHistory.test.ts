import { describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import {
  averageDrain,
  forecastPool,
  poolHistory,
  rollingDrain,
  windowPace,
  type QuotaLedgerSample,
} from '@/features/quota/ledger/history';
import { rateCeiling } from '@/features/quota/ledger/chartScale';
import { backInMs, headlineLimitId, quotaLimits } from '@/features/quota/ledger/limits';
import { buildPools } from '@/features/quota/ledger/pools';

const HOUR = 3_600_000;
const NOW = Date.parse('2099-01-05T12:00:00Z');
const t = ((key: string) => key) as unknown as TFunction;

const sample = (
  auth: string,
  hoursAgo: number,
  remaining: number,
  resetsAt: number | null = null
): QuotaLedgerSample => ({
  at: NOW - hoursAgo * HOUR,
  auth,
  provider: 'claude',
  window: 'seven-day',
  remaining,
  resets_at: resetsAt,
});

const claudeFilter = (auths: string[]) => ({ provider: 'claude', window: 'seven-day', auths });

describe('quota limits', () => {
  const claudeState = {
    status: 'success',
    windows: [
      {
        id: 'five-hour',
        label: '5-hour limit',
        usedPercent: 24,
        resetAtMs: NOW + HOUR,
        periodHours: 5,
      },
      {
        id: 'seven-day',
        label: '7-day limit',
        usedPercent: 100,
        resetAtMs: NOW + 10 * HOUR,
        periodHours: 168,
      },
      {
        id: 'seven-day-fable',
        label: '7-day Fable',
        usedPercent: 6,
        resetAtMs: NOW + 10 * HOUR,
        periodHours: 168,
      },
    ],
  };

  test('reads remaining percent, reset and period from provider usage', () => {
    expect(quotaLimits('claude', claudeState, t)).toEqual([
      {
        id: 'five-hour',
        label: '5-hour limit',
        remaining: 76,
        resetAtMs: NOW + HOUR,
        periodHours: 5,
      },
      {
        id: 'seven-day',
        label: '7-day limit',
        remaining: 0,
        resetAtMs: NOW + 10 * HOUR,
        periodHours: 168,
      },
      {
        id: 'seven-day-fable',
        label: '7-day Fable',
        remaining: 94,
        resetAtMs: NOW + 10 * HOUR,
        periodHours: 168,
      },
    ]);
  });

  test('reports nothing until the quota loaded', () => {
    expect(quotaLimits('claude', { status: 'loading', windows: [] }, t)).toEqual([]);
    expect(quotaLimits('codex', undefined, t)).toEqual([]);
  });

  test('picks the all-model weekly window as headline, else the longest window', () => {
    const limits = quotaLimits('claude', claudeState, t);
    expect(headlineLimitId('claude', limits)).toBe('seven-day');
    expect(headlineLimitId('kimi', [limits[0], limits[2]])).toBe('seven-day-fable');
  });

  test('an exhausted credential is back when its last empty window resets', () => {
    expect(backInMs(quotaLimits('claude', claudeState, t))).toBe(NOW + 10 * HOUR);
    expect(
      backInMs([{ id: 'a', label: 'a', remaining: 40, resetAtMs: NOW, periodHours: 5 }])
    ).toBeNull();
  });
});

describe('quota pools', () => {
  test('sums each limit across the loaded credentials of a provider', () => {
    const limit = (remaining: number, resetAtMs: number) => ({
      id: 'weekly',
      label: 'Weekly limit',
      remaining,
      resetAtMs,
      periodHours: 168,
    });
    const [pool] = buildPools(
      ['claude', 'codex'],
      [
        { provider: 'codex', auth: 'a.json', limits: [limit(100, NOW + 5 * HOUR)] },
        { provider: 'codex', auth: 'b.json', limits: [limit(4, NOW + 2 * HOUR)] },
        { provider: 'codex', auth: 'c.json', limits: [] },
      ],
      NOW
    );
    expect(pool.provider).toBe('codex');
    expect(pool.credentialCount).toBe(3);
    expect(pool.loadedCount).toBe(2);
    expect(pool.headline).toMatchObject({
      id: 'weekly',
      remaining: 104,
      capacity: 200,
      nextResetMs: NOW + 2 * HOUR,
    });
  });
});

describe('pool history', () => {
  test('sums credentials at each step, treats a passed reset as full and stale samples as gaps', () => {
    const samples = [sample('a', 3, 50), sample('b', 3, 20, NOW - 1.5 * HOUR), sample('a', 1, 40)];
    const points = poolHistory(samples, claudeFilter(['a', 'b']), NOW - 2 * HOUR, NOW, HOUR);
    expect(points.map((point) => point.value)).toEqual([70, 140, null]);
  });

  test('leaves a gap where a credential has no recent sample', () => {
    const samples = [
      sample('a', 6, 50),
      sample('b', 6, 50),
      sample('a', 1, 40),
      sample('b', 1, 40),
    ];
    const points = poolHistory(samples, claudeFilter(['a', 'b']), NOW - 5 * HOUR, NOW, HOUR);
    expect(points.map((point) => point.value)).toEqual([100, 100, null, null, 80, 80]);
  });
});

describe('drain rate', () => {
  test('measures spending per hour of history and skips resets', () => {
    const samples = [
      sample('a', 2, 90),
      sample('a', 1, 80),
      sample('a', 0.5, 100),
      sample('a', 0, 97),
    ];
    const rates = rollingDrain(samples, claudeFilter(['a']), NOW - HOUR, NOW, HOUR, HOUR);
    expect(rates.map((point) => point.value)).toEqual([10, 6]);
  });

  test('averages only the hours that have history', () => {
    const samples = [
      sample('a', 2, 90),
      sample('a', 1, 86),
      sample('b', 2, 50),
      sample('b', 1, 48),
    ];
    expect(averageDrain(samples, claudeFilter(['a', 'b']), NOW, 24 * HOUR)).toBe(6);
    expect(averageDrain([], claudeFilter(['a']), NOW, 24 * HOUR)).toBeNull();
  });

  test('reports no average until an hour of history exists', () => {
    const samples = [sample('a', 0.1, 72), sample('a', 0, 72)];
    expect(averageDrain(samples, claudeFilter(['a']), NOW, 24 * HOUR)).toBeNull();
  });

  test('weights the average by the time each measurement covers', () => {
    const samples = [sample('a', 3, 100), sample('a', 1, 90), sample('a', 0.5, 88)];
    expect(averageDrain(samples, claudeFilter(['a']), NOW, 24 * HOUR)).toBe(4.8);
  });
});

describe('rolling drain', () => {
  test('averages the trailing window at every step and leaves unmeasured steps empty', () => {
    const samples = [sample('a', 3, 100), sample('a', 2, 90), sample('a', 1, 88), sample('a', 0, 88)];
    const points = rollingDrain(samples, claudeFilter(['a']), NOW - 3 * HOUR, NOW, HOUR, HOUR);
    expect(points.map((point) => point.value)).toEqual([null, 10, 2, 0]);
  });
});

describe('window pace', () => {
  test('sums how fast each credential used its current window so far', () => {
    const pace = windowPace(
      [
        { auth: 'a', remaining: 72, resetAtMs: NOW + 48 * HOUR, periodHours: 168 },
        { auth: 'b', remaining: 0, resetAtMs: NOW + 8 * HOUR, periodHours: 168 },
        { auth: 'c', remaining: 100, resetAtMs: null, periodHours: 168 },
      ],
      NOW
    );
    expect(pace).toBeCloseTo(28 / 120 + 100 / 160, 6);
  });

  test('has no pace before any window has run for an hour', () => {
    const fresh = { auth: 'a', remaining: 99, resetAtMs: NOW + 167.5 * HOUR, periodHours: 168 };
    expect(windowPace([fresh], NOW)).toBeNull();
  });
});

describe('rate axis', () => {
  test('rounds the ceiling up to four even steps above the peak', () => {
    expect(rateCeiling(11)).toBe(20);
    expect(rateCeiling(3)).toBe(4);
    expect(rateCeiling(0)).toBe(4);
  });
});

describe('forecast', () => {
  test('drains the credential that resets first, then refills it at its reset', () => {
    const forecast = forecastPool(
      [
        { auth: 'late', remaining: 100, resetAtMs: NOW + 100 * HOUR, periodHours: 168 },
        { auth: 'soon', remaining: 30, resetAtMs: NOW + 4 * HOUR, periodHours: 168 },
      ],
      10,
      NOW,
      6 * HOUR,
      HOUR
    );
    expect(forecast.points.map((point) => point.value)).toEqual([
      130, 120, 110, 100, 190, 180, 170,
    ]);
    expect(forecast.nextReset).toEqual({ at: NOW + 4 * HOUR, gain: 100 });
    expect(forecast.emptyAtMs).toBeNull();
  });

  test('reports when the pool runs dry', () => {
    const forecast = forecastPool(
      [{ auth: 'a', remaining: 20, resetAtMs: NOW + 48 * HOUR, periodHours: 168 }],
      10,
      NOW,
      4 * HOUR,
      HOUR
    );
    expect(forecast.emptyAtMs).toBe(NOW + 2 * HOUR);
    expect(forecast.points.at(-1)?.value).toBe(0);
  });
});
