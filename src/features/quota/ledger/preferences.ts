/**
 * Quota ledger view preferences, kept across sessions in localStorage.
 */

export interface LedgerPreferences {
  view: 'ledger' | 'cards';
  showEmails: boolean;
  /** Provider whose pool chart is open; empty when all are closed. */
  pulseExpanded: string;
  horizon: '1' | '3' | '7';
  drainBasis: '6h' | '24h' | '7d';
  drainRange: '24h' | '3d' | '7d';
}

const STORAGE_KEY = 'quotaPage.ledgerPreferences';

const readAll = (): Partial<LedgerPreferences> => {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Partial<LedgerPreferences>) : {};
  } catch {
    return {};
  }
};

/** The stored value when it is one of `allowed` (or any string for open keys), else the fallback. */
export function readLedgerPreference<K extends keyof LedgerPreferences>(
  key: K,
  fallback: LedgerPreferences[K],
  allowed?: readonly LedgerPreferences[K][]
): LedgerPreferences[K] {
  const value = readAll()[key] as LedgerPreferences[K] | undefined;
  if (value === undefined) return fallback;
  if (allowed) return allowed.includes(value) ? value : fallback;
  return typeof value === typeof fallback ? value : fallback;
}

export function writeLedgerPreference<K extends keyof LedgerPreferences>(
  key: K,
  value: LedgerPreferences[K]
) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [key]: value }));
  } catch {
    // Storage full or blocked: the preference lasts until reload.
  }
}
