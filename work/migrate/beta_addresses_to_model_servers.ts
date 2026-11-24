/**
 * One-off migration for the owner's machine (owner, 2026-11-23): Maki's and Qwen Code's own "API address" boxes moved into
 * Settings > Model servers. A saved address becomes a model server with "Use with" switched on for that agent, so the owner gets its own
 * New chat entry next to the agent's normal one ("Maki · <server>", "Qwen Code · <server>"). Every agent works that way: a server
 * never changes the agent's normal entry. Migrations are scripts the owner runs, never app code (owner rule), so the app itself
 * carries no fallback beyond reading an address that is still saved.
 *
 * What it does, per Beta agent that has a saved API address (Maki: ANTHROPIC_BASE_URL, Qwen Code: OPENAI_BASE_URL):
 *   - adds a model server named after the address's host (the same address from both agents is ONE server with both switches on; an
 *     address that already is a model server gets the switch instead of a second entry),
 *   - switches "Use with" on for that agent: the server gets the agent's own entry (maki@<server>, qwen@<server>),
 *   - copies the agent's card key to the server (kept for every entry of that server) when the server has no key yet,
 *   - clears the address from the agent's card. The agent's key stays on its card, untouched, and the normal entry keeps working.
 * An agent whose address is already a model server with "Use with" on for it is skipped (its saved address is left as it is, and said so).
 *
 * Usage (from the repo folder; AIB and its keeper must be quit):
 *   deno run -A --config app/deno.json work/migrate/beta_addresses_to_model_servers.ts           dry run: prints the plan
 *   deno run -A --config app/deno.json work/migrate/beta_addresses_to_model_servers.ts --apply   does it
 * Option: --data <AIB data folder> (default: the per-user AIB data folder, %LOCALAPPDATA%\AgentStudio on Windows).
 * Safe to run again: an address that is already moved is no longer saved on the card, so there is nothing left to do.
 */
import { SettingsStore } from '../../app/server/state/settings.ts';
import { pathOf, userStateDir } from '../../app/server/state/paths.ts';
import { tryLockNow } from '../../app/server/platform/lock.ts';
import { LOCK_FILE } from '../../app/server/desktop/single_instance.ts';
import { keeperRunning } from '../../app/server/keeper/client.ts';
import { defaultServerName, USE_WITH } from '../../app/server/agents/model_servers.ts';
import { betaAgent } from '../../app/server/agents/beta_catalog.ts';

const say = (text = '') => console.log(text);
const held: Deno.FsFile[] = [];

export interface Options {
  apply: boolean;
  data: string;
}

export function parseArgs(args: string[]): Options {
  let data = '';
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--data') {
      data = args[++i] ?? '';
      if (!data || data.startsWith('--')) throw new Error('--data needs a folder');
    } else throw new Error(`unknown option ${args[i]}`);
  }
  return { apply, data: data || userStateDir() };
}

/** '' when no AIB runs for this data folder, else what does. On success the data folder's lock is held until the script ends. */
async function refuseWhileRunning(data: string): Promise<string> {
  if (keeperRunning(data)) return "AIB's keeper is running for this data folder";
  try {
    held.push(await tryLockNow(pathOf(data, LOCK_FILE), true));
  } catch {
    return 'AIB is running (its data folder is locked)';
  }
  return '';
}

interface Step {
  agent: string;
  agentName: string;
  address: string;
  /** the server it goes to: an existing one (id) or a new one (name) */
  server: { id: string } | { name: string };
}

/** What there is to do: one step per Beta agent that has a saved address and is not on a model server yet. */
export function plan(store: SettingsStore): { steps: Step[]; skipped: string[] } {
  const steps: Step[] = [];
  const skipped: string[] = [];
  const servers = store.modelServers();
  const newNames = new Map<string, string>(); // address -> the name chosen for the server this run adds
  for (const u of USE_WITH.filter((x) => x.agent === 'maki' || x.agent === 'qwen')) {
    const agent = betaAgent(u.agent);
    const address = store.betaUrl(u.agent);
    if (!agent || !address) continue;
    const same = servers.find((s) => s.url === address.replace(/\/+$/, ''));
    if (same && same.useWith.includes(u.agent)) {
      skipped.push(`${u.label}: already has the entry "${u.label} · ${same.name}"; its saved address ${address} is left as it is`);
      continue;
    }
    if (same) steps.push({ agent: u.agent, agentName: u.label, address, server: { id: same.id } });
    else {
      let name = newNames.get(address) ?? defaultServerName(address);
      if (!newNames.has(address)) {
        for (let n = 2; servers.some((s) => s.name.toLowerCase() === name.toLowerCase()) || [...newNames.values()].includes(name); n++) {
          name = `${defaultServerName(address).slice(0, 34)} ${n}`;
        }
        newNames.set(address, name);
      }
      steps.push({ agent: u.agent, agentName: u.label, address, server: { name } });
    }
  }
  return { steps, skipped };
}

export async function main(args: string[]): Promise<number> {
  try {
    return await run(args);
  } finally {
    for (const f of held.splice(0)) {
      try {
        f.close(); // lets go of the data folder's lock
      } catch { /* already closed */ }
    }
  }
}

async function run(args: string[]): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(args);
  } catch (error) {
    say(`${error instanceof Error ? error.message : error}`);
    return 2;
  }
  const running = await refuseWhileRunning(opts.data);
  if (running) {
    say(`Nothing was changed: ${running}. Quit AIB (tray icon > Quit AIB) and run this again.`);
    return 1;
  }
  const store = new SettingsStore(opts.data);
  const { steps, skipped } = plan(store);
  say(`AIB data folder: ${opts.data}`);
  for (const line of skipped) say(`  skip   ${line}`);
  if (!steps.length) {
    say(skipped.length ? 'Nothing to move.' : 'No saved API addresses on the Maki or Qwen Code cards: nothing to move.');
    return 0;
  }
  for (const s of steps) {
    const to = 'id' in s.server ? `the model server ${store.modelServer(s.server.id)!.name}` : `a new model server "${s.server.name}"`;
    say(`  ${opts.apply ? 'move  ' : 'would '} ${s.agentName}: ${s.address} -> ${to}, Use with on for ${s.agentName} (its own entry), the card's key is copied to the server, the card's address is cleared`);
  }
  if (!opts.apply) {
    say('');
    say('Dry run: nothing was changed. Run it again with --apply to do this.');
    return 0;
  }
  for (const s of steps) {
    // a second agent with the same address joins the server the first one made
    let id = 'id' in s.server ? s.server.id : idOfAddress(store, s.address);
    if (!id) {
      await store.update({ agents: { modelServer: { upsert: { name: (s.server as { name: string }).name, url: s.address, useWith: [] } } } });
      id = idOfAddress(store, s.address);
    }
    const server = store.modelServer(id);
    if (!server) throw new Error(`the model server for ${s.address} was not saved`);
    const cardKey = store.betaKey(s.agent);
    await store.update({
      agents: {
        modelServer: {
          upsert: { id, useWith: [...new Set([...server.useWith, s.agent])], ...(cardKey && !store.betaKey(id) ? { key: cardKey } : {}) },
        },
      },
    });
    await store.update({ agents: { betaUrl: { [s.agent]: null } } });
  }
  say('');
  say(`Done: ${steps.length} address${steps.length === 1 ? '' : 'es'} moved. Start AIB: Settings > Model servers lists them, and New chat has the new entries.`);
  return 0;
}

function idOfAddress(store: SettingsStore, address: string): string {
  return store.modelServers().find((s) => s.url === address.replace(/\/+$/, ''))?.id ?? '';
}

if (import.meta.main) Deno.exit(await main(Deno.args));
