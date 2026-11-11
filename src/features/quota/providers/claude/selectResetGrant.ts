import {
  anthropicResetGrantBlocker,
  type AnthropicResetGrant,
  type AnthropicResetGrantStatus,
  type AnthropicResetTarget,
} from '@/services/api/claudeResetGrants';

const inWindow = (grant: AnthropicResetGrant, now: number) =>
  (!grant.startsAt || Date.parse(grant.startsAt) <= now) &&
  (!grant.endsAt || Date.parse(grant.endsAt) > now);

const endsAt = (grant: AnthropicResetGrant) =>
  grant.endsAt ? Date.parse(grant.endsAt) : Number.POSITIVE_INFINITY;

/**
 * Prefer the upstream recommendation; otherwise use stable ID ordering.
 * With a target, only grants for that target count, and the one that expires first wins.
 */
export function selectResetGrant(
  status: AnthropicResetGrantStatus,
  now: number,
  target?: AnthropicResetTarget
) {
  if (status.cooldownUntil && Date.parse(status.cooldownUntil) > now) return undefined;
  const usable = status.grants.filter(
    (grant) =>
      (!target || grant.target === target) &&
      !anthropicResetGrantBlocker(status, grant.id) &&
      inWindow(grant, now)
  );
  const byId = (a: AnthropicResetGrant, b: AnthropicResetGrant) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (target) return usable.sort((a, b) => endsAt(a) - endsAt(b) || byId(a, b))[0];
  return usable.find((grant) => grant.id === status.nextGrantId) ?? usable.sort(byId)[0];
}

/** Why no grant of a target can be spent now: a reason code, or null when one can. */
export function resetTargetBlocker(
  status: AnthropicResetGrantStatus | null,
  now: number,
  target: AnthropicResetTarget
): string | null {
  if (!status) return 'loading';
  if (selectResetGrant(status, now, target)) return null;
  if (status.cooldownUntil && Date.parse(status.cooldownUntil) > now) return 'cooldown';
  const grants = status.grants.filter((grant) => grant.target === target);
  const left = grants.filter((grant) => grant.resetsLeft > 0 && inWindow(grant, now));
  if (left.length === 0) return 'none_left';
  if (!status.eligible) return 'ineligible';
  return left.find((grant) => grant.unavailableReason)?.unavailableReason ?? 'not_usable';
}
