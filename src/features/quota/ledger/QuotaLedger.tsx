/**
 * Ledger view: one dense row per credential, grouped by provider, every limit
 * side by side so the binding one is visible at a glance.
 */

import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import type { ResolvedTheme } from '@/features/authFiles/constants';
import { getTypeLabel } from '@/features/authFiles/constants';
import { formatInstantShort, formatRelativeInstant } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import { backInMs, type QuotaLimit } from './limits';
import { credentialLabel, formatDuration, lastSeenMs } from './presentation';
import styles from './QuotaLedger.module.scss';

export interface LedgerEntry {
  entry: QuotaFileEntry;
  quota: QuotaCardState | undefined;
  limits: QuotaLimit[];
}

export interface QuotaLedgerProps {
  groups: { provider: QuotaProviderType; rows: LedgerEntry[] }[];
  nowMs: number;
  showEmails: boolean;
  canUseActions: boolean;
  resettingName: string | null;
  resolvedTheme: ResolvedTheme;
  onRefresh: (entry: QuotaFileEntry) => void;
  onReset: (entry: QuotaFileEntry) => void;
}

const levelClass = (remaining: number | null) =>
  remaining === null
    ? styles.fillUnknown
    : remaining >= 70
      ? styles.fillHigh
      : remaining >= 30
        ? styles.fillMedium
        : styles.fillLow;

export function QuotaLedger(props: QuotaLedgerProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.ledger}>
      {props.groups.map((group) => (
        <section key={group.provider} className={styles.group}>
          <h2 className={styles.groupTitle}>
            {getTypeLabel(t, group.provider)}
            <span className={styles.groupCount}>{group.rows.length}</span>
          </h2>
          {group.rows.map((row) => (
            <LedgerRow
              key={`${row.entry.type}:${getQuotaCacheKey(row.entry.file)}`}
              row={row}
              {...props}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function LedgerRow({ row, ...props }: QuotaLedgerProps & { row: LedgerEntry }) {
  const { t, i18n } = useTranslation();
  const { entry, quota, limits } = row;
  const { file } = entry;
  const locale = i18n.resolvedLanguage;
  const adapter = QUOTA_ADAPTERS[entry.type];
  const backAt = backInMs(limits);
  const blocked = backAt !== null && backAt > props.nowMs;
  const seenAt = lastSeenMs(file);
  const cacheKey = getQuotaCacheKey(file);
  const canRefresh = props.canUseActions && !file.disabled && quota?.status !== 'loading';
  const canReset =
    Boolean(adapter.resetQuota) &&
    props.canUseActions &&
    quota?.status === 'success' &&
    Boolean((adapter.canResetQuota as ((q: unknown) => boolean) | undefined)?.(quota));

  return (
    <article className={`${styles.row} ${file.disabled ? styles.rowDisabled : ''}`}>
      <div className={styles.identity}>
        <span className={styles.name} title={file.name}>
          {credentialLabel(file, props.showEmails)}
        </span>
        <span className={styles.meta}>
          {getTypeLabel(t, entry.type)}
          {blocked && (
            <span className={styles.blocked}>
              {' · '}
              {t('quota_ledger.back_in', { duration: formatDuration(backAt - props.nowMs) })}
            </span>
          )}
          {file.disabled && <span className={styles.muted}> · {t('quota_ledger.disabled')}</span>}
        </span>
        {seenAt !== null && (
          <span className={styles.seen}>
            {t('quota_ledger.last_seen', {
              when: new Date(seenAt).toLocaleString(locale, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              }),
            })}
          </span>
        )}
      </div>

      <div className={styles.limits}>
        {quota?.status === 'success' && limits.length > 0 ? (
          limits.map((limit) => (
            <LimitCell
              key={limit.id}
              limit={limit}
              nowMs={props.nowMs}
              locale={locale}
              dimmed={blocked && (limit.remaining ?? 0) > 0}
            />
          ))
        ) : (
          <span className={quota?.status === 'error' ? styles.error : styles.muted}>
            {quota?.status === 'loading'
              ? t('quota_ledger.loading')
              : quota?.status === 'error'
                ? quota.error || t('quota_ledger.load_failed')
                : quota?.status === 'success'
                  ? t('quota_ledger.no_limits')
                  : t('quota_ledger.not_loaded')}
          </span>
        )}
      </div>

      <div className={styles.actions}>
        {adapter.resetQuota && (
          <button
            type="button"
            className={styles.action}
            disabled={!canReset || props.resettingName === cacheKey}
            onClick={() => props.onReset(entry)}
          >
            <IconRefreshCw size={13} />
            {t('quota_ledger.reset_limits')}
          </button>
        )}
        <button
          type="button"
          className={styles.action}
          disabled={!canRefresh}
          onClick={() => props.onRefresh(entry)}
        >
          <IconRefreshCw
            size={13}
            className={quota?.status === 'loading' ? styles.spinning : undefined}
          />
          {t('quota_ledger.refresh_quota')}
        </button>
      </div>
    </article>
  );
}

function LimitCell({
  limit,
  nowMs,
  locale,
  dimmed,
}: {
  limit: QuotaLimit;
  nowMs: number;
  locale?: string;
  dimmed: boolean;
}) {
  const { t } = useTranslation();
  const pending = limit.resetAtMs !== null && limit.resetAtMs > nowMs;
  return (
    <div className={`${styles.limit} ${dimmed ? styles.limitDimmed : ''}`}>
      <div className={styles.limitHeader}>
        <span className={styles.limitLabel} title={limit.label}>
          {limit.label}
        </span>
        <span className={styles.limitValue}>
          {limit.remaining === null ? '--' : `${Math.round(limit.remaining)}%`}
        </span>
      </div>
      <div className={styles.bar}>
        <div
          className={`${styles.fill} ${levelClass(limit.remaining)}`}
          style={{ width: `${limit.remaining ?? 0}%` }}
        />
      </div>
      <div className={styles.limitReset}>
        {pending ? (
          <>
            <span className={styles.limitRelative}>
              {formatRelativeInstant(limit.resetAtMs!, nowMs, locale)}
            </span>
            {' · '}
            {formatInstantShort(limit.resetAtMs!)}
          </>
        ) : (
          t('quota_ledger.no_reset_pending')
        )}
      </div>
    </div>
  );
}
