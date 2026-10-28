/**
 * Quota ledger state for the quota page: reads the server history and records
 * every quota the page loads, so the history also grows while someone looks.
 */

import { useEffect, useRef, useState } from 'react';
import { quotaLedgerApi } from '@/services/api/quotaLedger';
import { DAY_MS, MINUTE_MS } from '@/utils/time/durations';
import type { QuotaLedgerSample } from './history';
import type { CredentialLimits } from './pools';

export type QuotaLedgerStatus = 'loading' | 'ready' | 'unavailable' | 'error';

/** The longest chart range plus the history shown before "now". */
const HISTORY_SPAN_MS = 9 * DAY_MS;
const RELOAD_INTERVAL_MS = 5 * MINUTE_MS;

const statusOf = (error: unknown): QuotaLedgerStatus =>
  (error as { status?: number } | null)?.status === 404 ? 'unavailable' : 'error';

/** Samples for limits that changed since they were last recorded. */
export function changedSamples(
  credentials: readonly CredentialLimits[],
  recorded: Map<string, string>,
  nowMs: number
): QuotaLedgerSample[] {
  const samples: QuotaLedgerSample[] = [];
  for (const credential of credentials) {
    for (const limit of credential.limits) {
      if (limit.remaining === null) continue;
      const key = `${credential.provider}|${credential.auth}|${limit.id}`;
      const signature = `${limit.remaining}|${limit.resetAtMs ?? ''}`;
      if (recorded.get(key) === signature) continue;
      recorded.set(key, signature);
      samples.push({
        at: nowMs,
        auth: credential.auth,
        provider: credential.provider,
        window: limit.id,
        remaining: Math.round(limit.remaining * 100) / 100,
        resets_at: limit.resetAtMs,
      });
    }
  }
  return samples;
}

export function useQuotaLedger(credentials: readonly CredentialLimits[], enabled: boolean) {
  const [samples, setSamples] = useState<QuotaLedgerSample[]>([]);
  const [status, setStatus] = useState<QuotaLedgerStatus>('loading');
  const recordedRef = useRef(new Map<string, string>());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      try {
        const next = await quotaLedgerApi.list(Date.now() - HISTORY_SPAN_MS);
        if (cancelled) return;
        setSamples(next);
        setStatus('ready');
      } catch (error) {
        if (!cancelled) setStatus(statusOf(error));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), RELOAD_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || status !== 'ready') return;
    const fresh = changedSamples(credentials, recordedRef.current, Date.now());
    if (fresh.length === 0) return;
    setSamples((previous) => [...previous, ...fresh]);
    quotaLedgerApi.record(fresh).catch(() => {
      fresh.forEach((sample) =>
        recordedRef.current.delete(`${sample.provider}|${sample.auth}|${sample.window}`)
      );
    });
  }, [credentials, enabled, status]);

  return { samples, status };
}
