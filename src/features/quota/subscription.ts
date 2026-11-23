import type {
  ClaudeProfileResponse,
  ClaudeQuotaState,
  ClaudeSubscriptionInfo,
  CodexQuotaState,
  CodexSubscriptionInfo,
} from '@/types';
import {
  normalizeNumberValue,
  normalizePlanType,
  normalizeStringValue,
  resolveCodexPlanType,
  resolveCodexSubscriptionActiveUntil,
  resolveResetMs,
} from '@/utils/quota';
import type { QuotaFileEntry } from './logic';
import type { QuotaCardState } from './providers';

export type SubscriptionAutoRenew = 'auto' | 'cancels' | 'unknown';
export type SubscriptionBillingPeriod = 'monthly' | 'yearly';

export interface SubscriptionOverride {
  renewsAt?: string;
  autoRenew?: 'auto' | 'cancels';
  billingPeriod?: SubscriptionBillingPeriod;
  billingUrl?: string;
}

export interface ResolvedSubscription {
  renewalMs: number | null;
  renewalEstimated: boolean;
  autoRenew: SubscriptionAutoRenew;
  autoRenewSource: 'live' | 'override' | 'none';
  billingPeriod: string | null;
  billingUrl: string | null;
  defaultBillingUrl: string | null;
  invoiceUrl: string | null;
  accountEmail: string | null;
  isDelinquent: boolean;
  hasOverride: boolean;
}

const STORAGE_KEY = 'quotaPage.subscriptionOverrides';
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const parseInstantValue = (value: unknown): string | number | null => {
  const num = normalizeNumberValue(value);
  if (num !== null && num !== 0) return num;
  const str = normalizeStringValue(value);
  return str && str !== '0' ? str : null;
};

const normalizeBoolean = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;

export function sanitizeBillingUrl(raw: string | null | undefined): string | null {
  const trimmed = normalizeStringValue(raw);
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function parseCodexSubscriptionPayload(payload: unknown): CodexSubscriptionInfo | null {
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return null;
    try {
      return parseCodexSubscriptionPayload(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  if (!isRecord(payload)) return null;

  const entitlement = isRecord(payload.entitlement) ? payload.entitlement : null;
  const lastActive = isRecord(payload.last_active_subscription)
    ? payload.last_active_subscription
    : null;

  const activeUntil = parseInstantValue(payload.active_until ?? payload.activeUntil);
  const cancelsAt = parseInstantValue(entitlement?.cancels_at ?? payload.cancels_at);
  const expiresAt = parseInstantValue(entitlement?.expires_at) ?? activeUntil;
  const renewsAt = parseInstantValue(entitlement?.renews_at) ?? activeUntil ?? cancelsAt ?? expiresAt;
  const explicitWillRenew =
    normalizeBoolean(payload.will_renew) ?? normalizeBoolean(lastActive?.will_renew);
  const willRenew = explicitWillRenew !== null ? explicitWillRenew : cancelsAt ? false : null;
  const billingPeriod =
    normalizeStringValue(entitlement?.billing_period ?? payload.billing_period)?.toLowerCase() ??
    null;
  const isDelinquent = entitlement?.is_delinquent === true || payload.is_delinquent === true;

  if (
    renewsAt === null &&
    expiresAt === null &&
    cancelsAt === null &&
    willRenew === null &&
    billingPeriod === null &&
    !isDelinquent
  ) {
    return null;
  }

  return {
    renewsAt,
    expiresAt,
    cancelsAt,
    willRenew,
    billingPeriod,
    isDelinquent,
  };
}

export function parseClaudeSubscriptionInfo(
  profile: ClaudeProfileResponse | null
): ClaudeSubscriptionInfo | null {
  const org = profile?.organization;
  if (!org || !isRecord(org)) return null;

  const status = normalizeStringValue(org.subscription_status)?.toLowerCase() ?? null;
  const billingType = normalizeStringValue(org.billing_type)?.toLowerCase() ?? null;
  const createdAt = normalizeStringValue(org.subscription_created_at);
  const organizationType = normalizeStringValue(org.organization_type)?.toLowerCase() ?? null;
  const paymentAuthHostedInvoiceUrl = sanitizeBillingUrl(org.payment_auth_hosted_invoice_url);

  if (!status && !billingType && !createdAt && !organizationType && !paymentAuthHostedInvoiceUrl) {
    return null;
  }

  return {
    status,
    billingType,
    createdAt,
    organizationType,
    paymentAuthHostedInvoiceUrl,
  };
}

function clampUtcDay(year: number, monthIndex: number, day: number): number {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Math.min(day, lastDay);
}

export function estimateNextMonthlyRenewalMs(createdAt: string, nowMs: number): number | null {
  const startMs = Date.parse(createdAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) return null;

  const start = new Date(startMs);
  const anchorDay = start.getUTCDate();
  const hours = start.getUTCHours();
  const minutes = start.getUTCMinutes();
  const seconds = start.getUTCSeconds();

  const now = new Date(nowMs);
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();

  let candidate = Date.UTC(year, month, clampUtcDay(year, month, anchorDay), hours, minutes, seconds);
  if (candidate <= nowMs) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
    candidate = Date.UTC(year, month, clampUtcDay(year, month, anchorDay), hours, minutes, seconds);
  }
  return candidate;
}

export function parseOverrideDateMs(raw: string | undefined): number | null {
  const trimmed = normalizeStringValue(raw);
  if (!trimmed) return null;
  const match = DATE_ONLY_PATTERN.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day, 12, 0, 0);
  const verify = new Date(ms);
  if (
    verify.getUTCFullYear() !== year ||
    verify.getUTCMonth() !== month - 1 ||
    verify.getUTCDate() !== day
  ) {
    return null;
  }
  return ms;
}

export function formatDateInputValue(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function defaultBillingUrlFor(
  entry: QuotaFileEntry,
  quota?: QuotaCardState
): string | null {
  if (entry.type === 'codex') {
    const codexQuota = quota as CodexQuotaState | undefined;
    const plan = normalizePlanType(codexQuota?.planType ?? resolveCodexPlanType(entry.file));
    return plan === 'team'
      ? 'https://chatgpt.com/admin/billing'
      : 'https://chatgpt.com/#settings/Subscription';
  }
  if (entry.type === 'claude') {
    const claudeQuota = quota as ClaudeQuotaState | undefined;
    const isTeam =
      claudeQuota?.planType === 'plan_team' ||
      claudeQuota?.subscription?.organizationType === 'claude_team';
    return isTeam
      ? 'https://claude.ai/admin-settings/billing'
      : 'https://claude.ai/settings/billing';
  }
  if (entry.type === 'antigravity') {
    return 'https://one.google.com/settings';
  }
  if (entry.type === 'meta') {
    return 'https://www.meta.ai/settings';
  }
  return null;
}

function sanitizeOverride(raw: unknown): SubscriptionOverride | null {
  if (!isRecord(raw)) return null;
  const next: SubscriptionOverride = {};

  const dateStr = normalizeStringValue(raw.renewsAt);
  if (dateStr && parseOverrideDateMs(dateStr) !== null) {
    next.renewsAt = dateStr;
  }
  if (raw.autoRenew === 'auto' || raw.autoRenew === 'cancels') {
    next.autoRenew = raw.autoRenew;
  }
  if (raw.billingPeriod === 'monthly' || raw.billingPeriod === 'yearly') {
    next.billingPeriod = raw.billingPeriod;
  }
  const url = sanitizeBillingUrl(normalizeStringValue(raw.billingUrl));
  if (url) {
    next.billingUrl = url;
  }

  return Object.keys(next).length > 0 ? next : null;
}

const resolveStorage = (storage?: Storage): Storage | null => {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export function readSubscriptionOverrides(storage?: Storage): Record<string, SubscriptionOverride> {
  const target = resolveStorage(storage);
  if (!target) return {};
  try {
    const parsed = JSON.parse(target.getItem(STORAGE_KEY) ?? '{}') as unknown;
    if (!isRecord(parsed)) return {};
    const result: Record<string, SubscriptionOverride> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const clean = sanitizeOverride(value);
      if (clean) result[key] = clean;
    }
    return result;
  } catch {
    return {};
  }
}

export function writeSubscriptionOverride(
  key: string,
  override: SubscriptionOverride | null,
  storage?: Storage
): Record<string, SubscriptionOverride> {
  const current = readSubscriptionOverrides(storage);
  const clean = override ? sanitizeOverride(override) : null;
  const next = { ...current };
  if (clean) {
    next[key] = clean;
  } else {
    delete next[key];
  }
  const target = resolveStorage(storage);
  if (target) {
    try {
      target.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage full or blocked: keep state in memory for this session.
    }
  }
  return next;
}

export function resolveSubscriptionDisplay(
  entry: QuotaFileEntry,
  quota: QuotaCardState | undefined,
  override: SubscriptionOverride | undefined,
  nowMs: number
): ResolvedSubscription {
  const cleanOverride = override ? sanitizeOverride(override) : null;
  const defaultBillingUrl = defaultBillingUrlFor(entry, quota);
  const billingUrl = cleanOverride?.billingUrl ?? defaultBillingUrl;
  const accountEmail = normalizeStringValue(entry.file.email);

  let renewalMs = parseOverrideDateMs(cleanOverride?.renewsAt);
  let renewalEstimated = false;
  let autoRenew: SubscriptionAutoRenew = cleanOverride?.autoRenew ?? 'unknown';
  let autoRenewSource: 'live' | 'override' | 'none' = cleanOverride?.autoRenew ? 'override' : 'none';
  let billingPeriod: string | null = cleanOverride?.billingPeriod ?? null;
  let invoiceUrl: string | null = null;
  let isDelinquent = false;

  if (entry.type === 'codex') {
    const codexQuota = quota as CodexQuotaState | undefined;
    const sub = codexQuota?.subscription ?? null;
    if (renewalMs === null) {
      const instant =
        (sub?.willRenew === false ? sub.cancelsAt : null) ??
        sub?.renewsAt ??
        sub?.expiresAt ??
        codexQuota?.subscriptionActiveUntil ??
        resolveCodexSubscriptionActiveUntil(entry.file);
      renewalMs = resolveResetMs([instant]);
    }
    if (autoRenewSource === 'none' && sub?.willRenew !== null && sub?.willRenew !== undefined) {
      autoRenew = sub.willRenew ? 'auto' : 'cancels';
      autoRenewSource = 'live';
    }
    if (!billingPeriod && sub?.billingPeriod) {
      billingPeriod = sub.billingPeriod;
    }
    isDelinquent = sub?.isDelinquent === true;
  } else if (entry.type === 'claude') {
    const claudeQuota = quota as ClaudeQuotaState | undefined;
    const sub = claudeQuota?.subscription ?? null;
    invoiceUrl = sub?.paymentAuthHostedInvoiceUrl ?? null;
    const isPaidActive =
      claudeQuota?.planType !== 'plan_free' &&
      (sub?.status === 'active' || Boolean(sub?.billingType));
    if (renewalMs === null && isPaidActive && sub?.createdAt) {
      renewalMs = estimateNextMonthlyRenewalMs(sub.createdAt, nowMs);
      if (renewalMs !== null) {
        renewalEstimated = true;
      }
    }
  }

  return {
    renewalMs,
    renewalEstimated,
    autoRenew,
    autoRenewSource,
    billingPeriod,
    billingUrl,
    defaultBillingUrl,
    invoiceUrl,
    accountEmail,
    isDelinquent,
    hasOverride: cleanOverride !== null,
  };
}
