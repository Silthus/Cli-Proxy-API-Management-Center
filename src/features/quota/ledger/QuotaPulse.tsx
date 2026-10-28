/**
 * The pool headline: how much is left, how fast it goes, and where it is
 * heading. Each pool line expands into a remaining-quota forecast and a drain
 * rate history.
 */

import { useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown, IconChevronUp } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import type { ResolvedTheme } from '@/features/authFiles/constants';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import { capacityTicks, formatWeekdayClock, rateCeiling, rateTicks, timeTicks } from './chartScale';
import {
  averageDrain,
  drainRate,
  forecastPool,
  poolHistory,
  type QuotaLedgerSample,
  type SeriesFilter,
} from './history';
import { readLedgerPreference, writeLedgerPreference } from './preferences';
import type { PoolLimit, QuotaPool } from './pools';
import { ProviderMark } from './ProviderMark';
import { TimeChart } from './TimeChart';
import type { QuotaLedgerStatus } from './useQuotaLedger';
import styles from './QuotaPulse.module.scss';

const HORIZONS = { '1': DAY_MS, '3': 3 * DAY_MS, '7': 7 * DAY_MS } as const;
type HorizonDays = keyof typeof HORIZONS;
const DRAIN_BASES = { '6h': 6 * HOUR_MS, '24h': DAY_MS, '7d': 7 * DAY_MS } as const;
type DrainBasis = keyof typeof DRAIN_BASES;
/** Drain chart range → bucket size, so every range draws a readable number of points. */
const DRAIN_RANGES = {
  '24h': { span: DAY_MS, bucket: HOUR_MS },
  '3d': { span: 3 * DAY_MS, bucket: 3 * HOUR_MS },
  '7d': { span: 7 * DAY_MS, bucket: 6 * HOUR_MS },
} as const;
type DrainRange = keyof typeof DRAIN_RANGES;

/** Share of the forecast horizon shown as measured history before "now". */
const HISTORY_SHARE = 0.25;
const FORECAST_STEP_MS = 15 * MINUTE_MS;
const HISTORY_POINTS = 120;

/** Chart accents per provider; others use the theme's primary color. */
const CHART_ACCENTS: Partial<Record<string, string>> = {
  claude: '#e8794a',
  codex: '#8b8cff',
};

const PLUGIN_URL = 'https://github.com/Silthus/cliproxy-quota-ledger';

const levelClass = (remaining: number, capacity: number) => {
  const ratio = capacity > 0 ? remaining / capacity : 0;
  return ratio >= 0.7 ? styles.levelHigh : ratio >= 0.3 ? styles.levelMedium : styles.levelLow;
};

const filterFor = (provider: string, limit: PoolLimit): SeriesFilter => ({
  provider,
  window: limit.id,
  auths: limit.members.map((member) => member.auth),
});

export interface QuotaPulseProps {
  pools: QuotaPool[];
  samples: QuotaLedgerSample[];
  ledgerStatus: QuotaLedgerStatus;
  nowMs: number;
  resolvedTheme: ResolvedTheme;
}

export function QuotaPulse({
  pools,
  samples,
  ledgerStatus,
  nowMs,
  resolvedTheme,
}: QuotaPulseProps) {
  const [expanded, setExpanded] = useState(() => readLedgerPreference('pulseExpanded', ''));
  const [basis, setBasis] = useState<DrainBasis>(() =>
    readLedgerPreference('drainBasis', '24h', ['6h', '24h', '7d'])
  );
  const measured = pools.filter((pool) => pool.headline !== null);
  if (measured.length === 0) return null;

  const toggle = (provider: string) => {
    const next = expanded === provider ? '' : provider;
    setExpanded(next);
    writeLedgerPreference('pulseExpanded', next);
  };
  const changeBasis = (next: DrainBasis) => {
    setBasis(next);
    writeLedgerPreference('drainBasis', next);
  };

  return (
    <section className={styles.pulse}>
      {measured.map((pool) => (
        <PoolPulse
          key={pool.provider}
          pool={pool}
          headline={pool.headline!}
          showProvider={measured.length > 1}
          samples={samples}
          ledgerStatus={ledgerStatus}
          nowMs={nowMs}
          resolvedTheme={resolvedTheme}
          expanded={expanded === pool.provider}
          onToggle={() => toggle(pool.provider)}
          basis={basis}
          onBasisChange={changeBasis}
        />
      ))}
    </section>
  );
}

interface PoolPulseProps {
  pool: QuotaPool;
  headline: PoolLimit;
  showProvider: boolean;
  samples: QuotaLedgerSample[];
  ledgerStatus: QuotaLedgerStatus;
  nowMs: number;
  resolvedTheme: ResolvedTheme;
  expanded: boolean;
  onToggle: () => void;
  basis: DrainBasis;
  onBasisChange: (basis: DrainBasis) => void;
}

function PoolPulse(props: PoolPulseProps) {
  const { pool, headline, samples, nowMs, expanded, basis } = props;
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<'remaining' | 'drain'>('remaining');
  const filter = useMemo(() => filterFor(pool.provider, headline), [pool.provider, headline]);
  const drain = useMemo(
    () => averageDrain(samples, filter, nowMs, DRAIN_BASES[basis]),
    [samples, filter, nowMs, basis]
  );
  const forecast = useMemo(
    () =>
      drain === null
        ? null
        : forecastPool(headline.members, drain, nowMs, 7 * DAY_MS, FORECAST_STEP_MS),
    [drain, headline.members, nowMs]
  );
  const locale = i18n.resolvedLanguage;

  return (
    <div
      className={styles.pool}
      style={
        CHART_ACCENTS[pool.provider]
          ? ({ '--chart-accent': CHART_ACCENTS[pool.provider] } as CSSProperties)
          : undefined
      }
    >
      <button
        type="button"
        className={styles.summary}
        aria-expanded={expanded}
        onClick={props.onToggle}
      >
        {props.showProvider && (
          <span className={styles.summaryProvider}>
            <ProviderMark provider={pool.provider} resolvedTheme={props.resolvedTheme} />
            <span className={styles.summaryLimit}>{headline.label}</span>
          </span>
        )}
        <span className={styles.summaryFigure}>
          <span
            className={`${styles.summaryValue} ${levelClass(headline.remaining, headline.capacity)}`}
          >
            {Math.round(headline.remaining)}%
          </span>
          <span className={styles.summaryCapacity}>
            {t('quota_ledger.of_capacity_remaining', { capacity: headline.capacity })}
          </span>
        </span>
        {drain !== null && (
          <span className={styles.summaryRate}>
            {t('quota_ledger.per_hour_approx', { rate: drain.toFixed(1) })}
          </span>
        )}
        {forecast?.emptyAtMs != null && (
          <span className={styles.summaryWarning}>
            {t('quota_ledger.runs_dry', { when: formatWeekdayClock(forecast.emptyAtMs, locale) })}
          </span>
        )}
        <span className={styles.summaryChevron} aria-hidden="true">
          {expanded ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
        </span>
      </button>

      {expanded && (
        <div className={styles.panel}>
          <div className={styles.viewTabs} role="tablist">
            {(['remaining', 'drain'] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={view === id}
                className={`${styles.viewTab} ${view === id ? styles.viewTabActive : ''}`}
                onClick={() => setView(id)}
              >
                {t(`quota_ledger.view_${id}`)}
              </button>
            ))}
          </div>
          {props.ledgerStatus === 'unavailable' ? (
            <p className={styles.notice}>
              {t('quota_ledger.plugin_missing')}{' '}
              <a href={PLUGIN_URL} target="_blank" rel="noreferrer">
                quota-ledger
              </a>
            </p>
          ) : props.ledgerStatus === 'error' ? (
            <p className={styles.notice}>{t('quota_ledger.history_failed')}</p>
          ) : view === 'remaining' ? (
            <RemainingView
              headline={headline}
              samples={samples}
              filter={filter}
              nowMs={nowMs}
              forecast={forecast}
              basis={basis}
              onBasisChange={props.onBasisChange}
            />
          ) : (
            <DrainView samples={samples} filter={filter} nowMs={nowMs} />
          )}
        </div>
      )}
    </div>
  );
}

interface RemainingViewProps {
  headline: PoolLimit;
  samples: QuotaLedgerSample[];
  filter: SeriesFilter;
  nowMs: number;
  forecast: ReturnType<typeof forecastPool> | null;
  basis: DrainBasis;
  onBasisChange: (basis: DrainBasis) => void;
}

function RemainingView({
  headline,
  samples,
  filter,
  nowMs,
  forecast,
  basis,
  onBasisChange,
}: RemainingViewProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const [horizon, setHorizon] = useState<HorizonDays>(() =>
    readLedgerPreference('horizon', '7', ['1', '3', '7'])
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const horizonMs = HORIZONS[horizon];
  const fromMs = nowMs - horizonMs * HISTORY_SHARE;
  const toMs = nowMs + horizonMs;

  const history = useMemo(() => {
    const stepMs = Math.max(5 * MINUTE_MS, (nowMs - fromMs) / HISTORY_POINTS);
    const points = poolHistory(samples, filter, fromMs, nowMs, stepMs);
    return [...points, { at: nowMs, value: headline.remaining }];
  }, [samples, filter, fromMs, nowMs, headline.remaining]);
  const projected = useMemo(
    () => forecast?.points.filter((point) => point.at <= toMs) ?? [],
    [forecast, toMs]
  );

  return (
    <>
      <div className={styles.chartHeader}>
        <div className={styles.legend}>
          <span className={styles.legendSolid}>{t('quota_ledger.legend_remaining')}</span>
          <span className={styles.legendDashed}>{t('quota_ledger.legend_projected')}</span>
        </div>
        <label className={styles.rangeControl}>
          <span>{t('quota_ledger.next')}</span>
          <Select
            size="sm"
            value={horizon}
            ariaLabel={t('quota_ledger.forecast_range')}
            options={(Object.keys(HORIZONS) as HorizonDays[]).map((value) => ({
              value,
              label: t('quota_ledger.days', { count: Number(value) }),
            }))}
            onChange={(value) => {
              setHorizon(value as HorizonDays);
              writeLedgerPreference('horizon', value as HorizonDays);
            }}
          />
        </label>
      </div>
      <TimeChart
        points={history}
        projected={projected}
        yMax={headline.capacity}
        yTicks={capacityTicks(headline.capacity)}
        xFrom={fromMs}
        xTo={toMs}
        xTicks={timeTicks(fromMs, toMs, locale)}
        nowMs={nowMs}
        nowLabel={t('quota_ledger.now')}
        ariaLabel={t('quota_ledger.remaining_chart_label', {
          remaining: Math.round(headline.remaining),
          capacity: headline.capacity,
        })}
        formatTooltip={(point) =>
          t('quota_ledger.tooltip_left', {
            when: formatWeekdayClock(point.at, locale),
            value: Math.round(point.value),
          })
        }
      />
      <div className={styles.chartFooter}>
        <span>
          {forecast === null
            ? t('quota_ledger.forecast_needs_history')
            : forecast.nextReset
              ? t('quota_ledger.next_reset', {
                  gain: Math.round(forecast.nextReset.gain),
                  when: formatWeekdayClock(forecast.nextReset.at, locale),
                })
              : t('quota_ledger.no_reset_in_range')}
        </span>
        <button
          type="button"
          className={styles.settingsToggle}
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          {settingsOpen ? '▾' : '▸'} {t('quota_ledger.forecast_settings')}
        </button>
      </div>
      {settingsOpen && (
        <div className={styles.settings}>
          <span>{t('quota_ledger.basis_label')}</span>
          <Select
            size="sm"
            value={basis}
            ariaLabel={t('quota_ledger.basis_label')}
            options={(Object.keys(DRAIN_BASES) as DrainBasis[]).map((value) => ({
              value,
              label: t(`quota_ledger.basis_${value}`),
            }))}
            onChange={(value) => onBasisChange(value as DrainBasis)}
          />
          <span className={styles.settingsHint}>{t('quota_ledger.forecast_model')}</span>
        </div>
      )}
    </>
  );
}

interface DrainViewProps {
  samples: QuotaLedgerSample[];
  filter: SeriesFilter;
  nowMs: number;
}

function DrainView({ samples, filter, nowMs }: DrainViewProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const [range, setRange] = useState<DrainRange>(() =>
    readLedgerPreference('drainRange', '24h', ['24h', '3d', '7d'])
  );
  const { span, bucket } = DRAIN_RANGES[range];
  const fromMs = nowMs - span;
  const points = useMemo(
    () => drainRate(samples, filter, fromMs, nowMs, bucket),
    [samples, filter, fromMs, nowMs, bucket]
  );
  const peak = points.reduce((max, point) => Math.max(max, point.value ?? 0), 0);
  const ceiling = rateCeiling(peak);
  const hasData = points.some((point) => point.value !== null);

  return (
    <>
      <div className={styles.chartHeader}>
        <div className={styles.legend}>
          <span className={styles.legendSolid}>{t('quota_ledger.legend_rate')}</span>
          <span className={styles.legendNote}>
            {t('quota_ledger.bucket_average', { count: bucket / HOUR_MS })}
          </span>
        </div>
        <label className={styles.rangeControl}>
          <span>{t('quota_ledger.show')}</span>
          <Select
            size="sm"
            value={range}
            ariaLabel={t('quota_ledger.drain_range')}
            options={(Object.keys(DRAIN_RANGES) as DrainRange[]).map((value) => ({
              value,
              label: t(`quota_ledger.range_${value}`),
            }))}
            onChange={(value) => {
              setRange(value as DrainRange);
              writeLedgerPreference('drainRange', value as DrainRange);
            }}
          />
        </label>
      </div>
      <TimeChart
        points={points}
        yMax={ceiling}
        yTicks={rateTicks(ceiling)}
        xFrom={fromMs}
        xTo={nowMs}
        xTicks={timeTicks(fromMs, nowMs, locale)}
        ariaLabel={t('quota_ledger.drain_chart_label', { peak: peak.toFixed(1) })}
        formatTooltip={(point) =>
          t('quota_ledger.tooltip_rate', {
            when: formatWeekdayClock(point.at, locale),
            value: point.value.toFixed(1),
          })
        }
      />
      <div className={styles.chartFooter}>
        <span>
          {hasData
            ? t('quota_ledger.peak', { value: peak.toFixed(1) })
            : t('quota_ledger.no_drain_history')}
        </span>
        <span className={styles.footerNote}>{t('quota_ledger.drain_note')}</span>
      </div>
    </>
  );
}
