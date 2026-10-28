/**
 * One card per provider pool: the headline limit summed across credentials,
 * a segment per credential, and the next reset.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/features/authFiles/constants';
import { formatInstantShort, formatRelativeInstant } from '@/utils/quota';
import type { PoolLimit, QuotaPool } from './pools';
import { ProviderMark } from './ProviderMark';
import styles from './QuotaLedger.module.scss';

export interface ProviderSummaryCardsProps {
  pools: QuotaPool[];
  nowMs: number;
  resolvedTheme: ResolvedTheme;
}

const segmentClass = (remaining: number) =>
  remaining >= 70 ? styles.fillHigh : remaining >= 30 ? styles.fillMedium : styles.fillLow;

export function ProviderSummaryCards({ pools, nowMs, resolvedTheme }: ProviderSummaryCardsProps) {
  if (pools.length === 0) return null;
  return (
    <div className={styles.cards}>
      {pools.map((pool) => (
        <PoolCard key={pool.provider} pool={pool} nowMs={nowMs} resolvedTheme={resolvedTheme} />
      ))}
    </div>
  );
}

function PoolCard({
  pool,
  nowMs,
  resolvedTheme,
}: {
  pool: QuotaPool;
  nowMs: number;
  resolvedTheme: ResolvedTheme;
}) {
  const { t, i18n } = useTranslation();
  const [showOthers, setShowOthers] = useState(false);
  const { headline } = pool;
  const locale = i18n.resolvedLanguage;

  return (
    <article className={styles.card}>
      <header className={styles.cardHeader}>
        <ProviderMark provider={pool.provider} resolvedTheme={resolvedTheme} />
        <span className={styles.cardCount}>
          {t('quota_ledger.credential_count', { count: pool.credentialCount })}
        </span>
      </header>

      <span className={styles.cardLabel}>{headline?.label ?? t('quota_ledger.weekly_limit')}</span>
      <div className={styles.cardFigure}>
        <span className={styles.cardValue}>
          {headline ? `${Math.round(headline.remaining)}%` : '--'}
        </span>
        <span className={styles.cardCapacity}>
          {t('quota_ledger.of_capacity', {
            capacity: headline?.capacity ?? pool.credentialCount * 100,
          })}
        </span>
      </div>
      <Segments limit={headline} credentialCount={pool.credentialCount} />
      <span className={styles.cardFoot}>
        {headline === null
          ? t('quota_ledger.not_loaded_yet')
          : headline.nextResetMs !== null
            ? `${formatRelativeInstant(headline.nextResetMs, nowMs, locale)} · ${formatInstantShort(headline.nextResetMs)}`
            : t('quota_ledger.no_reset_pending')}
      </span>

      {pool.others.length > 0 && (
        <div className={styles.cardOthers}>
          <button
            type="button"
            className={styles.cardOthersToggle}
            aria-expanded={showOthers}
            onClick={() => setShowOthers((open) => !open)}
          >
            {showOthers
              ? t('quota_ledger.hide_limits')
              : t('quota_ledger.show_limits', { count: pool.others.length })}
          </button>
          {showOthers &&
            pool.others.map((limit) => (
              <div key={limit.id} className={styles.cardOther}>
                <span>{limit.label}</span>
                <span className={styles.cardOtherValue}>
                  {Math.round(limit.remaining)}%{' '}
                  <span className={styles.muted}>/ {limit.capacity}%</span>
                </span>
              </div>
            ))}
        </div>
      )}
    </article>
  );
}

function Segments({
  limit,
  credentialCount,
}: {
  limit: PoolLimit | null;
  credentialCount: number;
}) {
  const members = limit?.members ?? [];
  const placeholders = Math.max(0, credentialCount - members.length);
  return (
    <div className={styles.segments} aria-hidden="true">
      {members.map((member) => (
        <span key={member.auth} className={styles.segment}>
          <span
            className={`${styles.segmentFill} ${segmentClass(member.remaining)}`}
            style={{ width: `${member.remaining}%` }}
          />
        </span>
      ))}
      {Array.from({ length: placeholders }, (_, index) => (
        <span key={`empty-${index}`} className={styles.segment} />
      ))}
    </div>
  );
}
