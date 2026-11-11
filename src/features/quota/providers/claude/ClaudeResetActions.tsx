import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { RESET_ARM_WINDOW_MS, resetReasonKey, type ClaudeResetAction } from './resetTargets';

interface ClaudeResetButtonsProps {
  actions: readonly ClaudeResetAction[];
  busy: boolean;
  onPress: (target: ClaudeResetAction['target']) => void;
  buttonClassName: string;
  armedClassName: string;
  spinningClassName: string;
}

/** One footer button per reset target. The first press arms it, the second spends. */
export function ClaudeResetButtons({
  actions,
  busy,
  onPress,
  buttonClassName,
  armedClassName,
  spinningClassName,
}: ClaudeResetButtonsProps) {
  const { t } = useTranslation();
  return (
    <>
      {actions.map((action) => {
        const label = action.retry
          ? t('claude_reset.retry')
          : t(`claude_reset.${action.armed ? 'confirm' : 'use'}_${action.target}`);
        const title = action.reason
          ? t(resetReasonKey(action.reason), { code: action.reason })
          : t(`claude_reset.hint_${action.target}`);
        return (
          <button
            key={action.target}
            type="button"
            className={`${buttonClassName}${action.armed ? ` ${armedClassName}` : ''}`}
            disabled={action.blocked}
            aria-pressed={action.armed}
            onClick={() => onPress(action.target)}
            title={title}
          >
            <IconRefreshCw size={13} className={busy ? spinningClassName : undefined} />
            {label}
          </button>
        );
      })}
    </>
  );
}

/** Says what the armed button will spend, so the second press is an informed one. */
export function ClaudeResetArmedNotice({
  actions,
  name,
  className,
}: {
  actions: readonly ClaudeResetAction[];
  name: string;
  className: string;
}) {
  const { t } = useTranslation();
  const armed = actions.find((action) => action.armed);
  if (!armed) return null;
  return (
    <div role="status" className={className}>
      {t(`claude_reset.armed_${armed.target}`, {
        name,
        left: armed.left ?? 0,
        used: armed.percentUsed ?? '--',
        seconds: RESET_ARM_WINDOW_MS / 1000,
      })}
    </div>
  );
}
