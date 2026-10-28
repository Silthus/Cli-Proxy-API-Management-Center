/**
 * A single-series time chart: a solid measured line, an optional dashed
 * projection, a "now" marker, and a crosshair with one tooltip.
 *
 * The SVG stretches to its box (`preserveAspectRatio="none"`) with
 * non-scaling strokes, so it needs no measuring. Labels, the crosshair and the
 * hover dot are HTML positioned in percent, so they never distort.
 */

import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { ChartPoint } from './history';
import styles from './QuotaPulse.module.scss';

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 300;

export interface ChartTick {
  at: number;
  label: string;
}

export interface TimeChartProps {
  points: ChartPoint[];
  projected?: ChartPoint[];
  yMax: number;
  yTicks: { value: number; label: string }[];
  xFrom: number;
  xTo: number;
  xTicks: ChartTick[];
  nowMs?: number;
  nowLabel?: string;
  ariaLabel: string;
  formatTooltip: (point: { at: number; value: number }) => string;
}

interface Segment {
  points: { x: number; y: number }[];
}

function segmentsOf(points: ChartPoint[], x: (at: number) => number, y: (v: number) => number) {
  const segments: Segment[] = [];
  let current: Segment | null = null;
  for (const point of points) {
    if (point.value === null) {
      current = null;
      continue;
    }
    if (!current) {
      current = { points: [] };
      segments.push(current);
    }
    current.points.push({ x: x(point.at), y: y(point.value) });
  }
  return segments;
}

const linePath = (segments: Segment[]) =>
  segments
    .map((segment) =>
      segment.points
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
        .join('')
    )
    .join('');

const areaPath = (segments: Segment[]) =>
  segments
    .filter((segment) => segment.points.length > 1)
    .map((segment) => {
      const first = segment.points[0];
      const last = segment.points[segment.points.length - 1];
      const line = segment.points.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
      return `M${first.x.toFixed(1)},${VIEW_HEIGHT}${line}L${last.x.toFixed(1)},${VIEW_HEIGHT}Z`;
    })
    .join('');

export function TimeChart(props: TimeChartProps) {
  const { points, projected = [], yMax, yTicks, xFrom, xTo, xTicks, nowMs, nowLabel } = props;
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const span = Math.max(1, xTo - xFrom);
  const ceiling = Math.max(1, yMax);
  const xPercent = (at: number) => ((at - xFrom) / span) * 100;
  const yPercent = (value: number) => 100 - (Math.min(value, ceiling) / ceiling) * 100;

  const { solidLine, solidArea, projectedLine, projectedArea, hoverable } = useMemo(() => {
    const x = (at: number) => ((at - xFrom) / span) * VIEW_WIDTH;
    const y = (value: number) => VIEW_HEIGHT - (Math.min(value, ceiling) / ceiling) * VIEW_HEIGHT;
    const solid = segmentsOf(points, x, y);
    const dashed = segmentsOf(projected, x, y);
    return {
      solidLine: linePath(solid),
      solidArea: areaPath(solid),
      projectedLine: linePath(dashed),
      projectedArea: areaPath(dashed),
      hoverable: [...points, ...projected]
        .filter((point): point is { at: number; value: number } => point.value !== null)
        .sort((a, b) => a.at - b.at),
    };
  }, [points, projected, xFrom, span, ceiling]);

  const hovered = hoverIndex === null ? null : (hoverable[hoverIndex] ?? null);

  const nearestIndex = (at: number) => {
    let best = -1;
    let bestDistance = Infinity;
    hoverable.forEach((point, index) => {
      const distance = Math.abs(point.at - at);
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    });
    return best === -1 ? null : best;
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const fraction = (event.clientX - box.left) / box.width;
    setHoverIndex(nearestIndex(xFrom + fraction * span));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (hoverable.length === 0) return;
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const start = hoverIndex ?? nearestIndex(nowMs ?? xTo) ?? 0;
    setHoverIndex(Math.min(hoverable.length - 1, Math.max(0, start + step)));
  };

  const hoveredLeft = hovered ? xPercent(hovered.at) : 0;

  return (
    <div className={styles.chart}>
      <div className={styles.chartYAxis} aria-hidden="true">
        {yTicks.map((tick) => (
          <span key={tick.value} style={{ top: `${yPercent(tick.value)}%` }}>
            {tick.label}
          </span>
        ))}
      </div>
      <div
        className={styles.chartPlot}
        role="img"
        aria-label={props.ariaLabel}
        tabIndex={0}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverIndex(null)}
        onBlur={() => setHoverIndex(null)}
        onKeyDown={handleKeyDown}
      >
        {yTicks.map((tick) => (
          <div
            key={tick.value}
            className={styles.chartGridLine}
            style={{ top: `${yPercent(tick.value)}%` }}
          />
        ))}
        <svg
          className={styles.chartSvg}
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path className={styles.chartArea} d={solidArea} />
          <path className={styles.chartAreaProjected} d={projectedArea} />
          <path className={styles.chartLine} d={solidLine} />
          <path className={styles.chartLineProjected} d={projectedLine} />
        </svg>
        {nowMs !== undefined && nowMs >= xFrom && nowMs <= xTo && (
          <div className={styles.chartNow} style={{ left: `${xPercent(nowMs)}%` }}>
            {nowLabel && <span>{nowLabel}</span>}
          </div>
        )}
        {hovered && (
          <>
            <div className={styles.chartCrosshair} style={{ left: `${hoveredLeft}%` }} />
            <div
              className={styles.chartDot}
              style={{ left: `${hoveredLeft}%`, top: `${yPercent(hovered.value)}%` }}
            />
            <div
              className={`${styles.chartTooltip} ${hoveredLeft > 60 ? styles.chartTooltipLeft : ''}`}
              style={{ left: `${hoveredLeft}%` }}
              role="status"
            >
              {props.formatTooltip(hovered)}
            </div>
          </>
        )}
      </div>
      <div className={styles.chartXAxis} aria-hidden="true">
        {xTicks.map((tick) => (
          <span key={tick.at} style={{ left: `${xPercent(tick.at)}%` }}>
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
}
