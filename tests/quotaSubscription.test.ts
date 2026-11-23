import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TFunction } from 'i18next';
import i18n from '@/i18n';
import {
  estimateNextMonthlyRenewalMs,
  parseClaudeSubscriptionInfo,
  parseCodexSubscriptionPayload,
  readSubscriptionOverrides,
  resolveSubscriptionDisplay,
  sanitizeBillingUrl,
  writeSubscriptionOverride,
  type SubscriptionOverride,
} from '@/features/quota/subscription';
import { SubscriptionLine } from '@/features/quota/components/SubscriptionLine';
import { CLAUDE_CONFIG } from '@/features/quota/providers/claude/data';
import type { QuotaFileEntry } from '@/features/quota/logic';
import { apiCallApi, type ApiCallResult } from '@/services/api';
import { CLAUDE_PROFILE_URL, CLAUDE_USAGE_URL } from '@/utils/quota';
import type { ClaudeQuotaState, CodexQuotaState } from '@/types';

const t = ((key: string) => key) as TFunction;
const originalApiCallRequest = apiCallApi.request;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  apiCallApi.request = originalApiCallRequest;
});

const makeMemoryStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
};

describe('parseCodexSubscriptionPayload', () => {
  test('extracts renewal date, auto-renew flag, billing period, and delinquency from live ChatGPT payload', () => {
    const parsed = parseCodexSubscriptionPayload({
      id: 'sub-1',
      entitlement: {
        has_active_subscription: true,
        subscription_plan: 'chatgptpromax',
        expires_at: '2026-12-16T13:15:35+00:00',
        renews_at: '2026-12-16T07:15:35+00:00',
        cancels_at: null,
        billing_period: 'monthly',
        is_delinquent: false,
      },
      last_active_subscription: {
        will_renew: true,
      },
      active_until: '2026-12-16T07:15:35Z',
      billing_period: 'monthly',
      will_renew: true,
      is_delinquent: false,
    });

    expect(parsed).toEqual({
      renewsAt: '2026-12-16T07:15:35+00:00',
      expiresAt: '2026-12-16T13:15:35+00:00',
      cancelsAt: null,
      willRenew: true,
      billingPeriod: 'monthly',
      isDelinquent: false,
    });
  });

  test('detects cancellation when cancels_at is populated or will_renew is false', () => {
    const parsed = parseCodexSubscriptionPayload(
      JSON.stringify({
        entitlement: {
          expires_at: '2026-12-16T07:15:35+00:00',
          renews_at: null,
          cancels_at: '2026-12-16T07:15:35+00:00',
          billing_period: 'yearly',
          is_delinquent: true,
        },
        will_renew: false,
      })
    );

    expect(parsed).toEqual({
      renewsAt: '2026-12-16T07:15:35+00:00',
      expiresAt: '2026-12-16T07:15:35+00:00',
      cancelsAt: '2026-12-16T07:15:35+00:00',
      willRenew: false,
      billingPeriod: 'yearly',
      isDelinquent: true,
    });
  });

  test('preserves minimal legacy active_until payloads without fabricating auto-renew', () => {
    const parsed = parseCodexSubscriptionPayload({ active_until: '2026-10-03T13:27:01Z' });
    expect(parsed).toEqual({
      renewsAt: '2026-10-03T13:27:01Z',
      expiresAt: '2026-10-03T13:27:01Z',
      cancelsAt: null,
      willRenew: null,
      billingPeriod: null,
      isDelinquent: false,
    });
  });
});

describe('parseClaudeSubscriptionInfo and monthly estimate', () => {
  test('extracts subscription status, billing type, created_at, org type, and https invoice URL', () => {
    const info = parseClaudeSubscriptionInfo({
      organization: {
        organization_type: 'claude_max',
        billing_type: 'stripe_subscription',
        subscription_status: 'active',
        subscription_created_at: '2026-11-05T06:10:00.363170Z',
        payment_auth_hosted_invoice_url: 'https://invoice.stripe.com/i/acct_123',
      },
    });

    expect(info).toEqual({
      status: 'active',
      billingType: 'stripe_subscription',
      createdAt: '2026-11-05T06:10:00.363170Z',
      organizationType: 'claude_max',
      paymentAuthHostedInvoiceUrl: 'https://invoice.stripe.com/i/acct_123',
    });
  });

  test('rejects non-https invoice URLs', () => {
    const info = parseClaudeSubscriptionInfo({
      organization: {
        subscription_status: 'active',
        payment_auth_hosted_invoice_url: 'javascript:alert(1)',
      },
    });
    expect(info?.paymentAuthHostedInvoiceUrl).toBeNull();
  });

  test('estimates the next monthly renewal date from subscription_created_at and clamps short months', () => {
    const now = Date.UTC(2026, 10, 23, 5, 0, 0); // 2026-11-23
    expect(estimateNextMonthlyRenewalMs('2026-11-05T06:10:00Z', now)).toBe(
      Date.UTC(2026, 11, 5, 6, 10, 0)
    );
    expect(estimateNextMonthlyRenewalMs('2025-08-30T16:49:22Z', now)).toBe(
      Date.UTC(2026, 10, 30, 16, 49, 22)
    );
    // Clamping Jan 31 -> Feb 28 in non-leap year 2027
    const febNow = Date.UTC(2027, 1, 10, 0, 0, 0);
    expect(estimateNextMonthlyRenewalMs('2026-01-31T12:00:00Z', febNow)).toBe(
      Date.UTC(2027, 1, 28, 12, 0, 0)
    );
  });
});

describe('resolveSubscriptionDisplay', () => {
  const now = Date.UTC(2026, 10, 23, 5, 0, 0);

  test('uses live Codex renewal and auto-renew state and picks team vs personal billing URL', () => {
    const entry: QuotaFileEntry = {
      type: 'codex',
      file: {
        name: 'codex-team.json',
        type: 'codex',
        email: 'ops@example.com',
        id_token: { plan_type: 'team', chatgpt_subscription_active_until: '2027-05-28T15:56:34Z' },
      },
    };
    const quota: CodexQuotaState = {
      status: 'success',
      windows: [],
      planType: 'team',
      subscriptionActiveUntil: '2027-05-28T15:56:34Z',
      subscription: {
        renewsAt: '2027-05-28T15:56:34+00:00',
        expiresAt: '2027-05-28T21:56:34+00:00',
        cancelsAt: null,
        willRenew: true,
        billingPeriod: 'yearly',
        isDelinquent: false,
      },
    };

    const resolved = resolveSubscriptionDisplay(entry, quota, undefined, now);
    expect(resolved.renewalMs).toBe(Date.parse('2027-05-28T15:56:34+00:00'));
    expect(resolved.renewalEstimated).toBe(false);
    expect(resolved.autoRenew).toBe('auto');
    expect(resolved.autoRenewSource).toBe('live');
    expect(resolved.billingPeriod).toBe('yearly');
    expect(resolved.billingUrl).toBe('https://chatgpt.com/admin/billing');
    expect(resolved.accountEmail).toBe('ops@example.com');
    expect(resolved.hasOverride).toBe(false);
  });

  test('estimates Claude monthly renewal from subscription_created_at and lets manual overrides supersede it', () => {
    const entry: QuotaFileEntry = {
      type: 'claude',
      file: { name: 'claude-max.json', type: 'claude', email: 'max@example.com' },
    };
    const quota: ClaudeQuotaState = {
      status: 'success',
      windows: [],
      planType: 'plan_max20',
      subscription: {
        status: 'active',
        billingType: 'stripe_subscription',
        createdAt: '2026-11-05T06:10:00Z',
        organizationType: 'claude_max',
        paymentAuthHostedInvoiceUrl: null,
      },
    };

    const estimated = resolveSubscriptionDisplay(entry, quota, undefined, now);
    expect(estimated.renewalMs).toBe(Date.UTC(2026, 11, 5, 6, 10, 0));
    expect(estimated.renewalEstimated).toBe(true);
    expect(estimated.autoRenew).toBe('unknown');
    expect(estimated.billingUrl).toBe('https://claude.ai/settings/billing');

    const override: SubscriptionOverride = {
      renewsAt: '2026-12-05',
      autoRenew: 'cancels',
      billingPeriod: 'monthly',
      billingUrl: 'https://billing.stripe.com/p/session/custom',
    };
    const overridden = resolveSubscriptionDisplay(entry, quota, override, now);
    expect(overridden.renewalMs).toBe(Date.UTC(2026, 11, 5, 12, 0, 0));
    expect(overridden.renewalEstimated).toBe(false);
    expect(overridden.autoRenew).toBe('cancels');
    expect(overridden.autoRenewSource).toBe('override');
    expect(overridden.billingPeriod).toBe('monthly');
    expect(overridden.billingUrl).toBe('https://billing.stripe.com/p/session/custom');
    expect(overridden.hasOverride).toBe(true);
  });

  test('routes Claude Team accounts to admin-settings/billing', () => {
    const entry: QuotaFileEntry = {
      type: 'claude',
      file: { name: 'claude-team.json', type: 'claude' },
    };
    const quota: ClaudeQuotaState = {
      status: 'success',
      windows: [],
      planType: 'plan_team',
      subscription: {
        status: 'active',
        billingType: 'stripe_subscription',
        createdAt: null,
        organizationType: 'claude_team',
        paymentAuthHostedInvoiceUrl: null,
      },
    };
    expect(resolveSubscriptionDisplay(entry, quota, undefined, now).billingUrl).toBe(
      'https://claude.ai/admin-settings/billing'
    );
  });
});

describe('sanitizeBillingUrl and localStorage persistence', () => {
  test('only allows https URLs', () => {
    expect(sanitizeBillingUrl('https://claude.ai/settings/billing')).toBe(
      'https://claude.ai/settings/billing'
    );
    expect(sanitizeBillingUrl('http://example.com')).toBeNull();
    expect(sanitizeBillingUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeBillingUrl('not a url')).toBeNull();
  });

  test('writes, reads, sanitizes, and clears per-credential overrides', () => {
    const storage = makeMemoryStorage();
    const afterWrite = writeSubscriptionOverride(
      'claude-1.json',
      {
        renewsAt: '2026-12-15',
        autoRenew: 'auto',
        billingPeriod: 'monthly',
        billingUrl: 'https://claude.ai/settings/billing',
      },
      storage
    );
    expect(afterWrite['claude-1.json']).toEqual({
      renewsAt: '2026-12-15',
      autoRenew: 'auto',
      billingPeriod: 'monthly',
      billingUrl: 'https://claude.ai/settings/billing',
    });
    expect(readSubscriptionOverrides(storage)).toEqual(afterWrite);

    const afterClear = writeSubscriptionOverride('claude-1.json', null, storage);
    expect(afterClear).toEqual({});
    expect(readSubscriptionOverrides(storage)).toEqual({});
  });
});

describe('Claude fetchQuota subscription extraction', () => {
  test('forwards subscription status, createdAt, org type, and hosted invoice URL from profile', async () => {
    const ok = (body: unknown): ApiCallResult => ({
      statusCode: 200,
      header: {},
      bodyText: JSON.stringify(body),
      body,
    });
    apiCallApi.request = async (payload) => {
      if (payload.url === CLAUDE_USAGE_URL) {
        return ok({
          five_hour: { utilization: 10, resets_at: '2026-11-23T10:00:00Z' },
          seven_day: { utilization: 40, resets_at: '2026-11-28T10:00:00Z' },
        });
      }
      if (payload.url === CLAUDE_PROFILE_URL) {
        return ok({
          account: { has_claude_max: true, has_claude_pro: false },
          organization: {
            organization_type: 'claude_max',
            billing_type: 'stripe_subscription',
            rate_limit_tier: 'default_claude_max_20x',
            subscription_status: 'active',
            subscription_created_at: '2026-11-05T06:10:00Z',
            payment_auth_hosted_invoice_url: null,
          },
        });
      }
      throw new Error(`Unexpected URL: ${payload.url}`);
    };

    const data = await CLAUDE_CONFIG.fetchQuota(
      { name: 'claude.json', type: 'claude', auth_index: 'claude:1' },
      t
    );
    const state = CLAUDE_CONFIG.buildSuccessState(data);
    expect(state.subscription).toEqual({
      status: 'active',
      billingType: 'stripe_subscription',
      createdAt: '2026-11-05T06:10:00Z',
      organizationType: 'claude_max',
      paymentAuthHostedInvoiceUrl: null,
    });
  });
});

describe('SubscriptionLine rendering', () => {
  test('renders renewal date, auto-renew badge, billing link, and copy-email action', () => {
    const now = Date.UTC(2026, 10, 23, 5, 0, 0);
    const resolved = resolveSubscriptionDisplay(
      {
        type: 'codex',
        file: { name: 'codex-pro.json', type: 'codex', email: 'me@example.com' },
      },
      {
        status: 'success',
        windows: [],
        planType: 'promax',
        subscription: {
          renewsAt: '2026-12-16T07:15:35+00:00',
          expiresAt: '2026-12-16T13:15:35+00:00',
          cancelsAt: null,
          willRenew: true,
          billingPeriod: 'monthly',
          isDelinquent: false,
        },
      },
      undefined,
      now
    );

    const html = renderToStaticMarkup(
      createElement(SubscriptionLine, {
        resolved,
        nowMs: now,
        variant: 'ledger',
        onSaveOverride: () => {},
      })
    );

    expect(html).toContain('Renews Dec 16');
    expect(html).toContain('Auto-renew');
    expect(html).toContain('Monthly');
    expect(html).toContain('href="https://chatgpt.com/#settings/Subscription"');
    expect(html).toContain('Copy email');
    expect(html).toContain('Edit');
  });

  test('renders Cancels label and No auto-renew badge when auto-renewal is off', () => {
    const now = Date.UTC(2026, 10, 23, 5, 0, 0);
    const resolved = resolveSubscriptionDisplay(
      {
        type: 'claude',
        file: { name: 'claude-1.json', type: 'claude', email: 'sub@example.com' },
      },
      { status: 'success', windows: [] },
      { renewsAt: '2026-12-05', autoRenew: 'cancels', billingPeriod: 'monthly' },
      now
    );

    const html = renderToStaticMarkup(
      createElement(SubscriptionLine, {
        resolved,
        nowMs: now,
        variant: 'card',
        onSaveOverride: () => {},
      })
    );

    expect(html).toContain('Cancels Dec 5');
    expect(html).toContain('No auto-renew');
    expect(html).toContain('href="https://claude.ai/settings/billing"');
  });
});
