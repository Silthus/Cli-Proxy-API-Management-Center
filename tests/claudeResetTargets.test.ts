import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { parseAnthropicResetGrantStatus } from '@/services/api/claudeResetGrants';
import {
  resetTargetBlocker,
  selectResetGrant,
} from '@/features/quota/providers/claude/selectResetGrant';
import {
  pressResetTarget,
  type ClaudeResetAction,
} from '@/features/quota/providers/claude/resetTargets';
import {
  ClaudeResetArmedNotice,
  ClaudeResetButtons,
} from '@/features/quota/providers/claude/ClaudeResetActions';

// The shape Anthropic returns for a Max account with a monthly full reset and Fable launch resets.
const weekly = {
  id: 'full-reset-2611',
  label: 'One full limit reset (November 2026)',
  resets_total: 1,
  resets_left: 1,
  starts_at: '2026-11-10T21:30:00+00:00',
  ends_at: '2026-12-10T22:00:00+00:00',
  clears: ['seven_day', 'seven_day_overage_included'],
  usable_now: true,
  use_requires_limit: false,
  percent_used: { seven_day: 100, seven_day_overage_included: 9 },
  type: 'weekly',
  unavailable_reason: null,
};
const fable = {
  ...weekly,
  id: 'launch-2610-fable',
  label: 'New model launch: one Fable reset',
  ends_at: '2027-03-09T07:59:00+00:00',
  clears: ['seven_day_overage_included'],
  percent_used: { seven_day_overage_included: 9 },
  type: 'full',
};
const fableSooner = { ...fable, id: 'launch-2610-fable-6mo', ends_at: '2027-02-09T07:59:00+00:00' };
const block = {
  eligible: true,
  at_limit: true,
  grants: [weekly, fable, fableSooner],
  next_grant_id: 'full-reset-2611',
};
const now = Date.parse('2026-11-11T12:00:00Z');
const parse = (value: unknown) => parseAnthropicResetGrantStatus(value)!;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('reset targets', () => {
  test('classifies the weekly and Fable grants and picks the one that expires first', () => {
    const status = parse(block);
    expect(status.grants.map((grant) => grant.target)).toEqual(['weekly', 'fable', 'fable']);
    expect(selectResetGrant(status, now, 'weekly')?.id).toBe('full-reset-2611');
    expect(selectResetGrant(status, now, 'fable')?.id).toBe('launch-2610-fable-6mo');
    expect(selectResetGrant(status, now)?.id).toBe('full-reset-2611');
  });

  test('a Fable reset blocked by a full weekly limit says to spend the weekly reset first', () => {
    const status = parse({
      ...block,
      grants: [weekly, { ...fable, usable_now: false, unavailable_reason: 'blocked_seven_day' }],
    });
    expect(selectResetGrant(status, now, 'fable')).toBeUndefined();
    expect(resetTargetBlocker(status, now, 'fable')).toBe('blocked_seven_day');
    expect(resetTargetBlocker(status, now, 'weekly')).toBeNull();
  });

  test('blocks a target with nothing left, an ineligible account, or no read yet', () => {
    expect(resetTargetBlocker(null, now, 'weekly')).toBe('loading');
    expect(resetTargetBlocker(parse({ ...block, grants: [fable] }), now, 'weekly')).toBe(
      'none_left'
    );
    expect(
      resetTargetBlocker(parse({ ...block, grants: [{ ...fable, resets_left: 0 }] }), now, 'fable')
    ).toBe('none_left');
    expect(resetTargetBlocker(parse({ ...block, eligible: false }), now, 'fable')).toBe(
      'ineligible'
    );
  });

  test('drops an unavailable reason that is not a plain code', () => {
    const status = parse({
      ...block,
      grants: [{ ...fable, usable_now: false, unavailable_reason: '<b>x</b>' }],
    });
    expect(status.grants[0].unavailableReason).toBeNull();
    expect(resetTargetBlocker(status, now, 'fable')).toBe('not_usable');
  });

  test('the first press arms, a second press on the same button spends', () => {
    expect(pressResetTarget(null, 'fable')).toBe('arm');
    expect(pressResetTarget('weekly', 'fable')).toBe('arm');
    expect(pressResetTarget('fable', 'fable')).toBe('spend');
  });
});

const action = (overrides: Partial<ClaudeResetAction>): ClaudeResetAction => ({
  target: 'weekly',
  grantId: 'full-reset-2611',
  left: 1,
  percentUsed: 100,
  blocked: false,
  reason: null,
  armed: false,
  retry: false,
  ...overrides,
});
const buttons = (actions: ClaudeResetAction[]) =>
  renderToStaticMarkup(
    createElement(ClaudeResetButtons, {
      actions,
      busy: false,
      onPress: () => {},
      buttonClassName: 'pill',
      armedClassName: 'armed',
      spinningClassName: 'spin',
    })
  );

describe('reset buttons', () => {
  test('shows one button per target and explains a disabled one', () => {
    const markup = buttons([
      action({}),
      action({
        target: 'fable',
        grantId: undefined,
        blocked: true,
        reason: 'blocked_seven_day',
      }),
    ]);
    expect(markup).toContain('>Reset weekly</button>');
    expect(markup).toContain('>Reset Fable</button>');
    expect(markup).toContain('title="The weekly limit is full. Spend the weekly reset first."');
    expect(markup.match(/disabled=""/g)).toHaveLength(1);
  });

  test('an armed button asks for the second click and the notice names what it spends', () => {
    const armed = [action({ target: 'fable', armed: true, left: 3, percentUsed: 15 })];
    expect(buttons(armed)).toContain('class="pill armed"');
    expect(buttons(armed)).toContain('aria-pressed="true"');
    expect(buttons(armed)).toContain('Click again: spend Fable reset');
    const notice = renderToStaticMarkup(
      createElement(ClaudeResetArmedNotice, { actions: armed, name: 'max-a', className: 'n' })
    );
    expect(notice).toContain('1 of 3 Fable resets on “max-a”');
    expect(notice).toContain('weekly Fable limit (15% used)');
    expect(
      renderToStaticMarkup(
        createElement(ClaudeResetArmedNotice, { actions: [action({})], name: 'x', className: 'n' })
      )
    ).toBe('');
  });

  test('an unknown upstream reason shows its code', () => {
    expect(buttons([action({ blocked: true, reason: 'blocked_new_thing' })])).toContain(
      '(blocked_new_thing)'
    );
  });
});
