'use strict';
// The composer's Limits chip (composer-chips.js describeLimits / describe / render): text from the account's usage-limit snapshot
// (server/state/usage_limits.ts), the Ctx colour rules (high at 85% or more, red when blocked), the hover lines (reset times local
// and "in 2h 10m", plan, freshness), no chip without data, and the in-place update while the chip row stays.
process.env.TZ = 'UTC'; // local times in the hover are checked as UTC
const { APP: APP_DIR } = require('./_paths');
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { page } = require('./fake_dom');
const chips = require(path.join(APP_DIR, 'composer-chips.js'));

const NOW = Date.UTC(2026, 10, 11, 12, 0); // Wed Nov 11 2026 12:00
const S = (ms) => Math.round(ms / 1000);
const MIN = 60000,
  HOUR = 60 * MIN;
const win = (id, label, name, minutes, usedPercent, resetsAt, extra = {}) => ({
  id,
  label,
  name,
  minutes,
  usedPercent,
  resetsAt,
  status: 'allowed',
  scope: '',
  ...extra,
});
const snapshot = (windows, extra = {}) => ({
  agent: 'claude',
  source: 'claude-acp',
  updatedAt: S(NOW - 3 * MIN),
  plan: '',
  windows,
  notes: [],
  blocked: null,
  ...extra,
});
const PRO = snapshot(
  [
    win('five_hour', '5h', '5-hour', 300, 42, S(NOW + 2 * HOUR + 10 * MIN)),
    win('seven_day', 'wk', 'Weekly', 10080, 18, S(Date.UTC(2026, 10, 15, 3, 0))),
  ],
  { notes: ['Extra usage: off'] },
);

test('Claude Pro: "5h 42% · wk 18%", each reset local and relative, extra usage, freshness', () => {
  const d = chips.describeLimits(PRO, NOW);
  assert.equal(d.value, '5h 42% · wk 18%');
  assert.equal(d.tone, '');
  assert.deepEqual(d.details, [
    '5-hour: 42% used · resets 14:10 (in 2h 10m)',
    'Weekly: 18% used · resets Sun 03:00 (in 3d 15h)',
    'Extra usage: off',
    'Updated 3 min ago',
  ]);
});

test('weekly-only plans: "wk 26%"; a model-scoped window is in the hover only; Codex plan name shown', () => {
  const ultra = snapshot([
    win('seven_day', 'wk', 'Weekly', 10080, 26, S(Date.UTC(2026, 10, 15, 2, 0))),
    win('seven_day_fable', 'wk Fable', 'Weekly · Fable', 10080, 0, S(Date.UTC(2026, 10, 15, 2, 0)), { scope: 'Fable' }),
  ]);
  const d = chips.describeLimits(ultra, NOW);
  assert.equal(d.value, 'wk 26%');
  assert.equal(d.details[1], 'Weekly · Fable: 0% used · resets Sun 02:00 (in 3d 14h)');
  // Only a scoped window known: it is shown rather than nothing.
  assert.equal(chips.describeLimits(snapshot([ultra.windows[1]]), NOW).value, 'wk Fable 0%');
  const codex = snapshot(
    [
      win('primary', '5h', '5-hour', 300, 4, S(NOW + 20 * MIN)),
      win('secondary', 'wk', 'Weekly', 10080, 48, S(NOW + 30 * 24 * HOUR)),
    ],
    { agent: 'codex', source: 'codex-rollout', plan: 'ChatGPT Plus', updatedAt: S(NOW - 2 * HOUR) },
  );
  const c = chips.describeLimits(codex, NOW);
  assert.equal(c.value, '5h 4% · wk 48%');
  assert.deepEqual(c.details, [
    '5-hour: 4% used · resets 12:20 (in 20m)',
    'Weekly: 48% used · resets Dec 11 12:00 (in 30d)',
    'Plan: ChatGPT Plus',
    'Updated 2 h ago',
  ]);
});

test('colours follow Ctx: high at 85% or more (as shown, rounded), red when a window is rejected or at 100%', () => {
  const at = (pct, extra) =>
    chips.describeLimits(snapshot([win('seven_day', 'wk', 'Weekly', 10080, pct, null, extra)]), NOW);
  assert.equal(at(84.4).tone, '');
  assert.equal(at(84.6).tone, 'high'); // the chip says 85%
  assert.equal(at(85).tone, 'high');
  assert.equal(at(99).tone, 'high');
  assert.equal(at(100).tone, 'blocked');
  assert.equal(at(100).details[0], 'Weekly: 100% used · limit reached');
  assert.equal(at(60, { status: 'rejected' }).tone, 'blocked');
  // A rejected window without a number still says so.
  const bare = chips.describeLimits(
    snapshot([win('five_hour', '5h', '5-hour', 300, null, null, { status: 'rejected' })]),
    NOW,
  );
  assert.deepEqual([bare.value, bare.tone], ['limit reached', 'blocked']);
});

test("Qwen's cap: 'limit reached' in red with the reset; once the reset has passed there is no chip", () => {
  const qwen = snapshot([], {
    agent: 'qwen',
    source: 'qwen-error',
    plan: 'Qwen Plus',
    notes: ['Weekly credits used up'],
    blocked: { resetsAt: S(NOW + 90 * MIN) },
    updatedAt: S(NOW - 20 * 1000),
  });
  const d = chips.describeLimits(qwen, NOW);
  assert.deepEqual([d.value, d.tone], ['limit reached', 'blocked']);
  assert.deepEqual(d.details, [
    'Limit reached · resets 13:30 (in 1h 30m)',
    'Plan: Qwen Plus',
    'Weekly credits used up',
    'Updated just now',
  ]);
  assert.equal(chips.describeLimits(qwen, NOW + 2 * HOUR), null);
});

test('no chip: no data, an agent with no source (the server sends null), or every window past its reset', () => {
  assert.equal(chips.describeLimits(null, NOW), null);
  assert.equal(chips.describeLimits({}, NOW), null);
  assert.equal(chips.describeLimits(snapshot([]), NOW), null);
  // The 5-hour window has reset: its old number is dropped and the weekly one stays.
  assert.equal(chips.describeLimits(PRO, NOW + 3 * HOUR).value, 'wk 18%');
  assert.equal(chips.describeLimits(PRO, Date.UTC(2026, 10, 16)), null);
  // describe(): after Ctx; absent for OMP (no limits) and for the New chat page.
  const usage = { size: 1000, used: 310 };
  const ids = (model) => chips.describe(model).chips.map((c) => c.id);
  assert.deepEqual(ids({ agent: 'Claude Code', usage, limits: PRO, now: NOW }), ['agent', 'ctx', 'limits']);
  assert.deepEqual(ids({ agent: 'OMP', usage, limits: null, now: NOW }), ['agent', 'ctx']);
  assert.deepEqual(ids({ agent: 'Codex', limits: PRO, now: NOW }), ['agent', 'limits']);
  const chip = chips.describe({ agent: 'Claude Code', usage, limits: PRO, now: NOW }).chips[2];
  assert.deepEqual([chip.label, chip.value, chip.tone], ['Limits', '5h 42% · wk 18%', '']);
});

test('freshness wording: minutes, hours, days', () => {
  const ago = (ms) =>
    chips
      .describeLimits(snapshot([win('w', 'wk', 'Weekly', 10080, 1, null)], { updatedAt: S(NOW - ms) }), NOW)
      .details.at(-1);
  assert.equal(ago(59 * MIN), 'Updated 59 min ago');
  assert.equal(ago(25 * HOUR), 'Updated 1 day ago');
  assert.equal(ago(72 * HOUR), 'Updated 3 days ago');
});

// ---- rendering --------------------------------------------------------------------------------------------------------
function chipBox() {
  const { document } = page();
  const box = document.createElement('div');
  document.body.append(box);
  // fake_dom has no sibling combinator: ".a + .b" is the next sibling of the first ".a".
  const plain = box.querySelector.bind(box);
  box.querySelector = (sel) => {
    const m = /^(\S+) \+ (\S+)$/.exec(sel);
    if (!m) return plain(sel);
    const first = plain(m[1]);
    if (!first || !first.parentNode) return null;
    const next = first.parentNode.children[first.parentNode.children.indexOf(first) + 1];
    return next && next.matches(m[2]) ? next : null;
  };
  return { document, box };
}

test('rendered: a focusable value-only chip with its hover lines; new numbers update it in place', () => {
  const { box } = chipBox();
  const model = { id: 'c1', agent: 'Claude Code', usage: { size: 1000, used: 310 }, limits: PRO, now: NOW };
  chips.render(box, model, { disabled: false, busy: false });
  const chip = box.querySelector('.chip-limits');
  assert.ok(chip, 'the Limits chip is drawn');
  assert.equal(chip.querySelector('.chip-v').textContent, '5h 42% · wk 18%');
  assert.equal(chip.querySelector('.chip-k').textContent, 'Limits'); // kept for screen readers; CSS hides it
  assert.equal(chip.getAttribute('aria-label'), 'Usage limits 5h 42% · wk 18%. Details');
  assert.equal(chip.tabIndex, 0);
  const tip = box.querySelector('.chip-limits + .chip-tip');
  assert.equal(tip.getAttribute('role'), 'tooltip');
  assert.equal(tip.querySelectorAll('.chip-tip-line').length, 4);
  // The order in the row: Ctx, then Limits.
  const order = box
    .querySelectorAll('.chip')
    .map((n) => [...n._class].find((c) => /^chip-(ctx|limits|agent)$/.test(c)));
  assert.deepEqual(order.filter(Boolean), ['chip-agent', 'chip-ctx', 'chip-limits']);
  // The weekly window hits its cap: same chip element, new text, red, new hover.
  const blocked = { ...PRO, windows: [PRO.windows[0], { ...PRO.windows[1], usedPercent: 100, status: 'rejected' }] };
  chips.render(box, { ...model, limits: blocked }, { disabled: false, busy: false });
  assert.equal(box.querySelector('.chip-limits'), chip);
  assert.equal(chip.querySelector('.chip-v').textContent, '5h 42% · wk 100%');
  assert.ok(chip._class.has('chip-tone-blocked'));
  assert.ok(!chip._class.has('chip-tone-high'));
  assert.equal(chip.getAttribute('aria-label'), 'Usage limits 5h 42% · wk 100%. Details');
  const lines = box
    .querySelector('.chip-limits + .chip-tip')
    .querySelectorAll('.chip-tip-line')
    .map((n) => n.textContent);
  assert.equal(lines[1], 'Weekly: 100% used · limit reached · resets Sun 03:00 (in 3d 15h)');
  // High tone.
  const high = { ...PRO, windows: [{ ...PRO.windows[0], usedPercent: 91 }] };
  chips.render(box, { ...model, limits: high }, { disabled: false, busy: false });
  assert.ok(chip._class.has('chip-tone-high') && !chip._class.has('chip-tone-blocked'));
});
