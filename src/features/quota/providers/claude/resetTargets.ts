import type { AnthropicResetGrant, AnthropicResetTarget } from '@/services/api/claudeResetGrants';

/** The reset buttons a Claude card shows, in footer order. */
export const RESET_TARGETS = ['weekly', 'fable'] as const satisfies readonly AnthropicResetTarget[];
/** How long the first press keeps a reset button armed. */
export const RESET_ARM_WINDOW_MS = 5000;

export interface ClaudeResetAction {
  target: AnthropicResetTarget;
  grantId: string | undefined;
  /** Resets of this target left across its grants, or null before the first read. */
  left: number | null;
  /** How full the window this reset clears is, when upstream reports it. */
  percentUsed: number | undefined;
  blocked: boolean;
  /** Why the button is disabled: a reason code, or null. */
  reason: string | null;
  armed: boolean;
  retry: boolean;
}

/** Spending needs two presses on the same button: the first arms it. */
export function pressResetTarget(
  armed: AnthropicResetTarget | null,
  target: AnthropicResetTarget
): 'arm' | 'spend' {
  return armed === target ? 'spend' : 'arm';
}

export function resetPercentUsed(grant: AnthropicResetGrant) {
  return grant.target === 'weekly'
    ? grant.percentUsed.seven_day
    : grant.percentUsed.seven_day_overage_included;
}

/** Translation key for a disabled reason; unknown upstream codes share one message. */
export function resetReasonKey(reason: string) {
  return [
    'loading',
    'none_left',
    'ineligible',
    'cooldown',
    'not_usable',
    'pending_other',
    'blocked_seven_day',
  ].includes(reason)
    ? `claude_reset.reason_${reason}`
    : 'claude_reset.reason_other';
}
