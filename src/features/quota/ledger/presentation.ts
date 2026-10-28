/**
 * Display helpers for ledger rows: names, durations and last activity.
 */

import type { AuthFileItem } from '@/types';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

const EMAIL_PATTERN = /([^\s@-]+)@([^\s@]+)/;

/**
 * The name a ledger row shows. With emails hidden, the file name keeps its
 * email domain but not the mailbox, so rows stay distinguishable without
 * putting addresses on screen.
 */
export function credentialLabel(file: AuthFileItem, showEmails: boolean): string {
  const email = file.email?.trim();
  if (showEmails && email) return email;
  const note = typeof file.note === 'string' ? file.note.trim() : '';
  if (note) return note;
  const base = file.name.replace(/\.json$/i, '');
  if (showEmails) return base;
  return base.replace(
    EMAIL_PATTERN,
    (_, mailbox: string, domain: string) => `${mailbox.slice(0, 1)}•••@${domain}`
  );
}

/** `2d 4h`, `10h 6m`, `14m` */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe >= DAY_MS) {
    return `${Math.floor(safe / DAY_MS)}d ${Math.floor((safe % DAY_MS) / HOUR_MS)}h`;
  }
  if (safe >= HOUR_MS) {
    return `${Math.floor(safe / HOUR_MS)}h ${Math.floor((safe % HOUR_MS) / MINUTE_MS)}m`;
  }
  return `${Math.max(1, Math.round(safe / MINUTE_MS))}m`;
}

/** Start of the newest recent-request bucket that saw traffic, if the server reports buckets. */
export function lastSeenMs(file: AuthFileItem): number | null {
  const buckets = file.recentRequests ?? file.recent_requests ?? [];
  let latest: number | null = null;
  for (const bucket of buckets) {
    if (bucket.success + bucket.failed <= 0 || !bucket.time) continue;
    const at = Date.parse(bucket.time);
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

/** Codex reports how many limit resets the account has left; other providers report none. */
export function resetsRemaining(quota: unknown): number | null {
  const count = (quota as { rateLimitResetCreditsAvailableCount?: unknown } | undefined)
    ?.rateLimitResetCreditsAvailableCount;
  return typeof count === 'number' ? count : null;
}
