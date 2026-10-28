/**
 * Quota ledger plugin API.
 *
 * The `quota-ledger` plugin keeps quota snapshots on the server so the quota
 * page can chart history the browser never saw. Its routes are plugin-declared
 * v0 Management API extensions, so they keep their declared path instead of
 * the v8 prefix.
 */

import type { QuotaLedgerSample } from '@/features/quota/ledger/history';
import { useAuthStore } from '@/stores';
import { normalizeApiBase } from '@/utils/connection';
import { apiClient } from './client';

const SAMPLES_PATH = '/v0/management/quota-ledger/samples';

const samplesUrl = () => `${normalizeApiBase(useAuthStore.getState().apiBase)}${SAMPLES_PATH}`;

const isSample = (value: unknown): value is QuotaLedgerSample => {
  if (!value || typeof value !== 'object') return false;
  const sample = value as Record<string, unknown>;
  return (
    typeof sample.at === 'number' &&
    typeof sample.auth === 'string' &&
    typeof sample.provider === 'string' &&
    typeof sample.window === 'string' &&
    typeof sample.remaining === 'number'
  );
};

export const quotaLedgerApi = {
  async list(sinceMs: number): Promise<QuotaLedgerSample[]> {
    const data = await apiClient.get<{ samples?: unknown }>(samplesUrl(), {
      params: { since: Math.floor(sinceMs) },
    });
    return Array.isArray(data?.samples) ? data.samples.filter(isSample) : [];
  },

  async record(samples: QuotaLedgerSample[]): Promise<void> {
    if (samples.length === 0) return;
    await apiClient.post(samplesUrl(), { samples });
  },
};
