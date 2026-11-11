import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { useAuthStore } from '@/stores/useAuthStore';
import { useNotificationStore } from '@/stores';
import { apiClient } from '@/services/api/client';
import {
  AnthropicResetGrantError,
  type AnthropicResetGrantStatus,
  type AnthropicResetTarget,
} from '@/services/api/claudeResetGrants';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/quota';
import {
  resetGrantOperations,
  RETRY_WINDOW_MS,
  ResetGrantPreflightError,
  resetGrantFailureMessageKey,
} from './resetGrantOperations';
import { resetTargetBlocker, selectResetGrant } from './selectResetGrant';
import {
  pressResetTarget,
  RESET_ARM_WINDOW_MS,
  RESET_TARGETS,
  resetPercentUsed,
  type ClaudeResetAction,
} from './resetTargets';
import { readResetGrantsForCard, scheduleResetGrantRead } from './resetGrantReads';

/** Card-owned reads; the session-scoped journal owns spending and ambiguous retries. */
export function useClaudeResetGrants(
  file: AuthFileItem,
  enabled: boolean,
  disabled: boolean,
  refreshToken: unknown,
  onRefresh: () => void
) {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const [session] = useState(() => apiClient.getConnectionRevision());
  const sessionActive =
    connectionStatus === 'connected' && session === apiClient.getConnectionRevision();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const now = useNow();
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  const key = JSON.stringify([file.name, authIndex]);
  const [status, setStatus] = useState<AnthropicResetGrantStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const lock = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    setStatus(null);
    if (!enabled || disabled || !sessionActive || !authIndex) return;
    let cancelled = false;
    const current = () =>
      !cancelled && version === generation.current && session === apiClient.getConnectionRevision();
    const cancelRead = scheduleResetGrantRead(() => {
      void readResetGrantsForCard(authIndex).then(
        (result) => {
          if (current()) {
            setStatus(result);
            setMessage('');
          }
        },
        (error: unknown) => {
          if (current()) {
            setMessage(
              error instanceof AnthropicResetGrantError && error.code === 'rate_limited'
                ? 'rate_limited'
                : 'read_error'
            );
          }
        }
      );
    }, current);
    return () => {
      cancelled = true;
      cancelRead();
      generation.current += 1;
    };
  }, [authIndex, key, enabled, disabled, sessionActive, session, refreshToken, reload]);

  const operation = resetGrantOperations.inspect(key);
  const pending = operation && !operation.code ? operation : undefined;
  const expired = Boolean(pending && now - pending.createdAt >= RETRY_WINDOW_MS);
  const [armed, setArmed] = useState<AnthropicResetTarget | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timeout = setTimeout(() => setArmed(null), RESET_ARM_WINDOW_MS);
    return () => clearTimeout(timeout);
  }, [armed]);
  const unavailable = disabled || !sessionActive || !authIndex || busy || expired;
  const actions: ClaudeResetAction[] = RESET_TARGETS.map((target) => {
    const pendingGrant = pending && status?.grants.find((grant) => grant.id === pending.grantId);
    const grant = pending
      ? pendingGrant?.target === target
        ? pendingGrant
        : undefined
      : status
        ? selectResetGrant(status, now, target)
        : undefined;
    const reason = pending
      ? grant
        ? null
        : 'pending_other'
      : resetTargetBlocker(status, now, target);
    return {
      target,
      grantId: grant?.id,
      left: status
        ? status.grants
            .filter((item) => item.target === target)
            .reduce((sum, item) => sum + item.resetsLeft, 0)
        : null,
      percentUsed: grant ? resetPercentUsed(grant) : undefined,
      blocked: unavailable || !grant,
      reason: unavailable && !reason ? null : reason,
      armed: armed === target,
      retry: Boolean(pending && grant),
    };
  });

  const spend = async (grantId: string) => {
    if (lock.current || !authIndex) return;
    const version = generation.current;
    const current = () =>
      session === apiClient.getConnectionRevision() && version === generation.current;
    if (!current() || useAuthStore.getState().connectionStatus !== 'connected') return;
    lock.current = true;
    setBusy(true);
    try {
      const answer = await resetGrantOperations.run(key, authIndex, grantId);
      if (!current()) return;
      showNotification(
        answer.code === 'cooldown_clear_failed'
          ? t('auth_files.cooldown_reset_failed', {
              name: file.name,
              message: t('common.unknown_error'),
            })
          : t(`claude_reset.${answer.unresolved ? 'unknown' : answer.code}`),
        !answer.unresolved && (answer.code === 'reset' || answer.code === 'already_used')
          ? 'success'
          : 'error'
      );
    } catch (error: unknown) {
      if (!current()) return;
      const unresolved = resetGrantOperations.inspect(key);
      showNotification(
        t(
          unresolved && !unresolved.code
            ? 'claude_reset.unknown'
            : resetGrantFailureMessageKey(error),
          {
            code: error instanceof ResetGrantPreflightError ? error.reason : '',
          }
        ),
        'error'
      );
    } finally {
      lock.current = false;
      // A concurrent page-wide refresh can invalidate this read generation.
      // Release the local lock regardless, but never refresh a replacement account.
      setBusy(false);
      setReload((value) => value + 1);
      if (current()) onRefresh();
    }
  };

  /** The first press arms the button; a second press within the window spends. */
  const press = (target: AnthropicResetTarget) => {
    const action = actions.find((item) => item.target === target);
    if (!action || action.blocked || !action.grantId || lock.current) return;
    if (pressResetTarget(armed, target) === 'arm') {
      setArmed(target);
      return;
    }
    setArmed(null);
    void spend(action.grantId);
  };

  return {
    count: status?.grants.reduce((sum, grant) => sum + grant.resetsLeft, 0) ?? null,
    grants: status?.grants ?? [],
    busy,
    actions,
    press,
    message: pending ? (expired ? 'expired' : 'unknown') : message,
  };
}
