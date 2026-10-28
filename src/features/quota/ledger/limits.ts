/**
 * One provider-neutral view of a credential's quota limits.
 *
 * The ledger, the provider summary cards and the burn-rate history all ask the
 * same three questions of every credential: how much is left, when does it
 * come back, and how long is the window. The provider states disagree about
 * where those answers live, so this is the single place that reads them.
 */

import type { TFunction } from 'i18next';
import type { QuotaProviderType } from '../providers/types';

export interface QuotaLimit {
  id: string;
  label: string;
  /** Percent remaining, 0..100; null when the provider reported no usage. */
  remaining: number | null;
  resetAtMs: number | null;
  periodHours: number | null;
}

const WEEK_HOURS = 168;

const HEADLINE_LIMIT_IDS: Partial<Record<QuotaProviderType, string>> = {
  claude: 'seven-day',
  codex: 'weekly',
};

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const remainingFromUsed = (used: unknown): number | null => {
  const value = finiteOrNull(used);
  return value === null ? null : clampPercent(100 - value);
};

interface LabelledRow {
  id?: string;
  label?: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
}

const labelOf = (row: LabelledRow, t: TFunction, fallback: string) =>
  row.label || (row.labelKey ? t(row.labelKey, row.labelParams) : '') || row.id || fallback;

interface UsedWindow extends LabelledRow {
  id: string;
  usedPercent: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

const fromUsedWindows = (windows: readonly UsedWindow[], t: TFunction): QuotaLimit[] =>
  windows.map((window) => ({
    id: window.id,
    label: labelOf(window, t, window.id),
    remaining: remainingFromUsed(window.usedPercent),
    resetAtMs: finiteOrNull(window.resetAtMs),
    periodHours: finiteOrNull(window.periodHours),
  }));

interface Bucket extends LabelledRow {
  id: string;
  remainingFraction: number;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

interface KimiRow extends LabelledRow {
  id: string;
  used: number;
  limit: number;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

interface DevinWindow extends LabelledRow {
  id: string;
  remainingPercent: number | null;
  resetAtMs: number | null;
  periodHours: number;
}

interface MetaWindow {
  id: string;
  usedPercent: number | null;
  resetAt?: number;
}

interface XaiBilling {
  periodType?: string;
  usedPercent?: number | null;
  usagePercent?: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

/** Every limit a loaded credential reports; empty until its quota loaded successfully. */
export function quotaLimits(
  provider: QuotaProviderType,
  quota: unknown,
  t: TFunction
): QuotaLimit[] {
  const state = quota as { status?: string } | undefined;
  if (!state || state.status !== 'success') return [];

  switch (provider) {
    case 'claude':
    case 'codex':
      return fromUsedWindows((quota as { windows?: UsedWindow[] }).windows ?? [], t);

    case 'devin':
      return ((quota as { windows?: DevinWindow[] }).windows ?? []).map((window) => ({
        id: window.id,
        label: labelOf(window, t, window.id),
        remaining: finiteOrNull(window.remainingPercent),
        resetAtMs: finiteOrNull(window.resetAtMs),
        periodHours: finiteOrNull(window.periodHours),
      }));

    case 'kimi':
      return ((quota as { rows?: KimiRow[] }).rows ?? []).map((row) => ({
        id: row.id,
        label: labelOf(row, t, row.id),
        remaining: row.limit > 0 ? clampPercent((1 - row.used / row.limit) * 100) : null,
        resetAtMs: finiteOrNull(row.resetAtMs),
        periodHours: finiteOrNull(row.periodHours),
      }));

    case 'antigravity':
    case 'plugin':
      return ((quota as { groups?: { buckets?: Bucket[] }[] }).groups ?? [])
        .flatMap((group) => group.buckets ?? [])
        .map((bucket) => ({
          id: bucket.id,
          label: labelOf(bucket, t, bucket.id),
          remaining: clampPercent(bucket.remainingFraction * 100),
          resetAtMs: finiteOrNull(bucket.resetAtMs),
          periodHours: finiteOrNull(bucket.periodHours),
        }));

    case 'meta':
      return ((quota as { data?: { windows?: MetaWindow[] } }).data?.windows ?? []).map(
        (window) => ({
          id: window.id,
          label: t(
            window.id === 'weekly' ? 'quota_ledger.weekly_limit' : 'quota_ledger.session_limit'
          ),
          remaining: remainingFromUsed(window.usedPercent),
          resetAtMs: typeof window.resetAt === 'number' ? window.resetAt * 1000 : null,
          periodHours: window.id === 'weekly' ? WEEK_HOURS : null,
        })
      );

    case 'xai': {
      const billing = (quota as { billing?: XaiBilling | null }).billing;
      if (!billing) return [];
      const weekly = billing.periodType === 'weekly';
      return [
        {
          id: weekly ? 'xai:weekly' : 'xai:monthly',
          label: t(weekly ? 'quota_ledger.weekly_limit' : 'quota_ledger.monthly_limit'),
          remaining: remainingFromUsed(billing.usedPercent ?? billing.usagePercent),
          resetAtMs: finiteOrNull(billing.resetAtMs),
          periodHours: finiteOrNull(billing.periodHours),
        },
      ];
    }
  }
}

/**
 * The limit that represents a credential's capacity in pools and charts:
 * the provider's all-model weekly window when it has one, otherwise the
 * longest window it reports.
 */
export function headlineLimitId(
  provider: QuotaProviderType,
  limits: readonly QuotaLimit[]
): string | null {
  const preferred = HEADLINE_LIMIT_IDS[provider];
  if (preferred && limits.some((limit) => limit.id === preferred)) return preferred;
  const measurable = limits.filter((limit) => limit.remaining !== null);
  if (measurable.length === 0) return null;
  return measurable.reduce((longest, limit) =>
    (limit.periodHours ?? 0) > (longest.periodHours ?? 0) ? limit : longest
  ).id;
}

/**
 * When an exhausted credential can serve again: every empty window must reset,
 * so the latest of their resets. Null while any window still has capacity.
 */
export function backInMs(limits: readonly QuotaLimit[]): number | null {
  const exhausted = limits.filter((limit) => limit.remaining !== null && limit.remaining <= 0);
  if (exhausted.length === 0) return null;
  const resets = exhausted.map((limit) => limit.resetAtMs);
  if (resets.some((reset) => reset === null)) return null;
  return Math.max(...(resets as number[]));
}
