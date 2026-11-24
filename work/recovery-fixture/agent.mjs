// Run the deterministic ACP fixture with session listing and a cancellable subagent; no model calls.
import { launchFake } from '../fakes/_launch.mjs';

launchFake(['--list-sessions', '--subagent'], { doc: 'Run the deterministic ACP fixture with session listing and a cancellable subagent; no model calls.' });
