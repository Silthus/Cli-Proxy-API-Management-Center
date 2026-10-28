/**
 * Quota pools: every credential of one provider, summed per limit.
 *
 * Seven Claude subscriptions at 100% each are a 700% pool. Reading the pool
 * as one number answers "how much do I have left this week" without adding up
 * seven cards by eye.
 */

import type { QuotaProviderType } from '../providers/types';
import { headlineLimitId, type QuotaLimit } from './limits';

export interface CredentialLimits {
  provider: QuotaProviderType;
  /** Credential file name; the ledger's series key. */
  auth: string;
  limits: QuotaLimit[];
}

export interface PoolMember {
  auth: string;
  remaining: number;
  resetAtMs: number | null;
  periodHours: number | null;
}

export interface PoolLimit {
  id: string;
  label: string;
  members: PoolMember[];
  remaining: number;
  capacity: number;
  nextResetMs: number | null;
}

export interface QuotaPool {
  provider: QuotaProviderType;
  credentialCount: number;
  /** Credentials whose quota has loaded. */
  loadedCount: number;
  headline: PoolLimit | null;
  /** Every other limit, in the order the provider reports them. */
  others: PoolLimit[];
}

const poolLimit = (id: string, label: string, members: PoolMember[], nowMs: number): PoolLimit => {
  const upcoming = members
    .map((member) => member.resetAtMs)
    .filter((reset): reset is number => reset !== null && reset > nowMs);
  return {
    id,
    label,
    members,
    remaining: members.reduce((sum, member) => sum + member.remaining, 0),
    capacity: members.length * 100,
    nextResetMs: upcoming.length > 0 ? Math.min(...upcoming) : null,
  };
};

function buildPool(
  provider: QuotaProviderType,
  credentials: readonly CredentialLimits[],
  nowMs: number
): QuotaPool {
  const loaded = credentials.filter((credential) => credential.limits.length > 0);
  const order: string[] = [];
  const labels = new Map<string, string>();
  const membersById = new Map<string, PoolMember[]>();

  for (const credential of loaded) {
    for (const limit of credential.limits) {
      if (limit.remaining === null) continue;
      if (!membersById.has(limit.id)) {
        order.push(limit.id);
        labels.set(limit.id, limit.label);
        membersById.set(limit.id, []);
      }
      membersById.get(limit.id)!.push({
        auth: credential.auth,
        remaining: limit.remaining,
        resetAtMs: limit.resetAtMs,
        periodHours: limit.periodHours,
      });
    }
  }

  const headlineId =
    loaded
      .map((credential) => headlineLimitId(provider, credential.limits))
      .find((id): id is string => id !== null && membersById.has(id)) ?? null;
  const limits = order.map((id) => poolLimit(id, labels.get(id)!, membersById.get(id)!, nowMs));

  return {
    provider,
    credentialCount: credentials.length,
    loadedCount: loaded.length,
    headline: limits.find((limit) => limit.id === headlineId) ?? null,
    others: limits.filter((limit) => limit.id !== headlineId),
  };
}

/** One pool per provider, in the given provider order, skipping providers without credentials. */
export function buildPools(
  providerOrder: readonly QuotaProviderType[],
  credentials: readonly CredentialLimits[],
  nowMs: number
): QuotaPool[] {
  return providerOrder
    .map((provider) => credentials.filter((credential) => credential.provider === provider))
    .filter((group) => group.length > 0)
    .map((group) => buildPool(group[0].provider, group, nowMs));
}
