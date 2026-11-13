/**
 * The phone's New chat lists agents with the PC's own rules: server/agents/eligibility.ts against agent-choice.js mergeRegistry
 * (the PC's New chat), on the same rows. Which agents can start a chat, in which order, and the Beta agents' reasons must match;
 * the built-ins get reasons too.
 */
import { assertEquals } from './_assert.ts';
import '../../outputs/agent-studio/agent-choice.js';
import { BETA_IDS, eligibleAgents, reasonWords, verdict } from '../../outputs/agent-studio/server/agents/eligibility.ts';

type Json = Record<string, unknown>;
interface Choice {
  mergeRegistry(rows: unknown): {
    all: { id: string; enabled: boolean; beta?: boolean }[];
    unavailable: { id: string; reason: string }[];
  };
  BETA_IDS: string[];
}
const AC = (globalThis as unknown as { AgentChoice: Choice }).AgentChoice;

const signin = { state: 'signin' };
const ROWS: (Json | null)[][] = [
  [],
  [{ id: 'claude', enabled: true, found: true }, { id: 'codex', enabled: false, found: true }, { id: 'omp', found: false }],
  [{ id: 'claude', found: true, signin }, { id: 'omp', enabled: true, found: true, signin: { state: 'ok' } }],
  [
    { id: 'gemini', beta: true, enabled: true, found: true, name: 'Gemini' },
    { id: 'kimi', beta: true, enabled: true, found: true, signin },
    { id: 'qwen', beta: true, enabled: false, found: true },
    { id: 'cursor', beta: true, found: false },
    { id: 'goose', beta: true, enabled: false, found: true, signin },
    { id: 'gemini', beta: true, enabled: false }, // a repeat is skipped
  ],
  [
    { id: 'custom-my-agent', name: 'Mine', enabled: true, found: true },
    { id: 'custom-off', name: 'Off', enabled: false, found: true },
    { id: 'custom-gone', found: false },
    { id: 'Bad Id', enabled: true },
    { id: 'notbeta', beta: true, enabled: true },
    null,
    { name: 'no id' },
  ],
];

Deno.test('agent eligibility matches agent-choice.js: the same agents can start a chat, in the same order, with the same Beta reasons', () => {
  assertEquals([...BETA_IDS], [...AC.BETA_IDS]);
  for (const rows of ROWS) {
    const pc = AC.mergeRegistry(rows);
    const phone = eligibleAgents(rows);
    assertEquals(phone.map((a) => a.id), pc.all.map((a) => a.id), JSON.stringify(rows));
    assertEquals(phone.map((a) => a.ok), pc.all.map((a) => a.enabled), JSON.stringify(rows));
    for (const u of pc.unavailable) assertEquals(phone.find((a) => a.id === u.id)?.reason, u.reason, u.id);
  }
});

Deno.test('every agent that cannot start a chat has a reason the phone can show', () => {
  assertEquals(verdict({ found: false }), { ok: false, reason: 'Not installed' });
  assertEquals(verdict({ enabled: false, found: true }), { ok: false, reason: 'Turned off in Settings' });
  assertEquals(verdict({ found: true, signin: { state: 'signin' } }), { ok: false, reason: 'Needs sign-in' });
  assertEquals(verdict({ found: true }), { ok: true, reason: '' });
  for (const r of ['Not installed', 'Needs sign-in', 'Turned off in Settings'] as const) assertEquals(reasonWords(r).length > 10, true);
});
