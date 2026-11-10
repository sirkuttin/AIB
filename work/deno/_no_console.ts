/**
 * Imported (through _assert.ts) by every Deno test file: on Windows, give the test process a console with no window first, as
 * main.ts and the agent host do at start. A `deno test` started without a console (a background job, an IDE, an agent) would
 * otherwise give every console program a test starts (icacls, git, python, agents) a visible window of its own.
 */
import { ensureHiddenConsole } from '../../outputs/agent-studio/server/platform/console.ts';

export const consoleSetup = ensureHiddenConsole();
