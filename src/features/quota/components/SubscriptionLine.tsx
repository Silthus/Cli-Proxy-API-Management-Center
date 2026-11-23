import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { IconCheck, IconCopy, IconExternalLink, IconPencil } from '@/components/ui/icons';
import { formatRelativeInstant } from '@/utils/quota';
import {
  formatDateInputValue,
  sanitizeBillingUrl,
  type ResolvedSubscription,
  type SubscriptionBillingPeriod,
  type SubscriptionOverride,
} from '../subscription';
import styles from './SubscriptionLine.module.scss';

export interface SubscriptionLineProps {
  resolved: ResolvedSubscription;
  override?: SubscriptionOverride;
  nowMs: number;
  variant: 'ledger' | 'card';
  onSaveOverride: (override: SubscriptionOverride | null) => void;
}

function formatRenewalDate(ms: number, nowMs: number, locale?: string): string {
  const date = new Date(ms);
  const sameYear = date.getUTCFullYear() === new Date(nowMs).getUTCFullYear();
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
      timeZone: 'UTC',
    }).format(date);
  } catch {
    return formatDateInputValue(ms);
  }
}

export function SubscriptionLine({
  resolved,
  override,
  nowMs,
  variant,
  onSaveOverride,
}: SubscriptionLineProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;

  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dateDraft, setDateDraft] = useState('');
  const [autoRenewDraft, setAutoRenewDraft] = useState<'' | 'auto' | 'cancels'>('');
  const [periodDraft, setPeriodDraft] = useState<'' | SubscriptionBillingPeriod>('');
  const [urlDraft, setUrlDraft] = useState('');
  const [urlError, setUrlError] = useState('');

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const openEditor = () => {
    setDateDraft(override?.renewsAt ?? formatDateInputValue(resolved.renewalMs));
    setAutoRenewDraft(override?.autoRenew ?? '');
    setPeriodDraft(override?.billingPeriod ?? '');
    setUrlDraft(override?.billingUrl ?? '');
    setUrlError('');
    setEditing(true);
  };

  const handleCopyEmail = async () => {
    if (!resolved.accountEmail) return;
    try {
      await navigator.clipboard.writeText(resolved.accountEmail);
      setCopied(true);
    } catch {
      // Clipboard unavailable outside secure contexts.
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedUrl = urlDraft.trim();
    if (trimmedUrl && !sanitizeBillingUrl(trimmedUrl)) {
      setUrlError(t('quota_subscription.invalid_url'));
      return;
    }

    const next: SubscriptionOverride = {};
    if (dateDraft.trim()) next.renewsAt = dateDraft.trim();
    if (autoRenewDraft === 'auto' || autoRenewDraft === 'cancels') next.autoRenew = autoRenewDraft;
    if (periodDraft === 'monthly' || periodDraft === 'yearly') next.billingPeriod = periodDraft;
    if (trimmedUrl) next.billingUrl = sanitizeBillingUrl(trimmedUrl)!;

    onSaveOverride(Object.keys(next).length > 0 ? next : null);
    setEditing(false);
  };

  const renewalDateText =
    resolved.renewalMs !== null ? formatRenewalDate(resolved.renewalMs, nowMs, locale) : null;
  const relativeText =
    resolved.renewalMs !== null && resolved.renewalMs > nowMs
      ? formatRelativeInstant(resolved.renewalMs, nowMs, locale)
      : null;

  const periodLabel =
    resolved.billingPeriod === 'monthly'
      ? t('quota_subscription.period_monthly')
      : resolved.billingPeriod === 'yearly'
        ? t('quota_subscription.period_yearly')
        : null;

  const hasSummary =
    renewalDateText !== null ||
    resolved.autoRenew !== 'unknown' ||
    periodLabel !== null ||
    resolved.isDelinquent;

  return (
    <div className={`${styles.container} ${variant === 'card' ? styles.card : ''}`}>
      {hasSummary && (
        <div className={styles.summaryRow}>
          {renewalDateText && (
            <span className={resolved.autoRenew === 'cancels' ? styles.dateCancels : styles.date}>
              {resolved.autoRenew === 'cancels'
                ? t('quota_subscription.cancels_on', { date: renewalDateText })
                : resolved.renewalEstimated
                  ? t('quota_subscription.renews_estimated', { date: renewalDateText })
                  : t('quota_subscription.renews_on', { date: renewalDateText })}
              {relativeText && <span className={styles.relative}>{` · ${relativeText}`}</span>}
            </span>
          )}
          {resolved.autoRenew === 'auto' && (
            <span className={`${styles.badge} ${styles.badgeAuto}`}>
              {t('quota_subscription.auto_renew')}
            </span>
          )}
          {resolved.autoRenew === 'cancels' && (
            <span className={`${styles.badge} ${styles.badgeCancels}`}>
              {t('quota_subscription.auto_renew_off')}
            </span>
          )}
          {periodLabel && (
            <span className={`${styles.badge} ${styles.badgePeriod}`}>{periodLabel}</span>
          )}
          {resolved.isDelinquent && (
            <span className={`${styles.badge} ${styles.badgeDanger}`}>
              {t('quota_subscription.payment_issue')}
            </span>
          )}
        </div>
      )}

      <div className={styles.actionsRow}>
        {resolved.billingUrl && (
          <a
            className={styles.billingLink}
            href={resolved.billingUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <IconExternalLink size={12} aria-hidden="true" />
            {t('quota_subscription.billing_link')}
          </a>
        )}
        {resolved.invoiceUrl && (
          <a
            className={styles.billingLink}
            href={resolved.invoiceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <IconExternalLink size={12} aria-hidden="true" />
            {t('quota_subscription.invoice_link')}
          </a>
        )}
        {resolved.accountEmail && (
          <button
            type="button"
            className={`${styles.actionButton} ${copied ? styles.copied : ''}`}
            onClick={() => void handleCopyEmail()}
            title={resolved.accountEmail}
          >
            {copied ? (
              <IconCheck size={12} aria-hidden="true" />
            ) : (
              <IconCopy size={12} aria-hidden="true" />
            )}
            {copied ? t('quota_subscription.copied_email') : t('quota_subscription.copy_email')}
          </button>
        )}
        <button
          type="button"
          className={styles.actionButton}
          onClick={() => (editing ? setEditing(false) : openEditor())}
          aria-expanded={editing}
        >
          <IconPencil size={12} aria-hidden="true" />
          {hasSummary ? t('quota_subscription.edit') : t('quota_subscription.set_renewal')}
        </button>
      </div>

      {editing && (
        <form className={styles.editor} onSubmit={handleSubmit}>
          <div className={styles.editorGrid}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                {t('quota_subscription.field_renewal_date')}
              </span>
              <input
                type="date"
                className={styles.input}
                value={dateDraft}
                onChange={(event) => setDateDraft(event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                {t('quota_subscription.field_auto_renew')}
              </span>
              <select
                className={styles.select}
                value={autoRenewDraft}
                onChange={(event) =>
                  setAutoRenewDraft(event.target.value as '' | 'auto' | 'cancels')
                }
              >
                <option value="">{t('quota_subscription.option_detected')}</option>
                <option value="auto">{t('quota_subscription.option_auto_renew')}</option>
                <option value="cancels">{t('quota_subscription.option_cancels')}</option>
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                {t('quota_subscription.field_billing_period')}
              </span>
              <select
                className={styles.select}
                value={periodDraft}
                onChange={(event) =>
                  setPeriodDraft(event.target.value as '' | SubscriptionBillingPeriod)
                }
              >
                <option value="">{t('quota_subscription.option_detected')}</option>
                <option value="monthly">{t('quota_subscription.period_monthly')}</option>
                <option value="yearly">{t('quota_subscription.period_yearly')}</option>
              </select>
            </label>
          </div>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('quota_subscription.field_billing_url')}</span>
            <input
              type="url"
              className={styles.input}
              value={urlDraft}
              placeholder={resolved.defaultBillingUrl ?? 'https://...'}
              onChange={(event) => {
                setUrlDraft(event.target.value);
                if (urlError) setUrlError('');
              }}
            />
          </label>
          {urlError && (
            <div role="alert" className={styles.editorError}>
              {urlError}
            </div>
          )}
          <div className={styles.editorActions}>
            <button type="submit" className={styles.saveButton}>
              {t('quota_subscription.save')}
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setEditing(false)}
            >
              {t('quota_subscription.cancel')}
            </button>
            {resolved.hasOverride && (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => {
                  onSaveOverride(null);
                  setEditing(false);
                }}
              >
                {t('quota_subscription.reset')}
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
