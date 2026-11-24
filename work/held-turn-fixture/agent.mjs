// Fake ACP agent in the Claude Code held-turn shape (fake_acp.mjs --held-turn), for the attention watcher tests. No model calls.
import { launchFake } from '../fakes/_launch.mjs';

launchFake(['--held-turn'], { doc: 'Fake ACP agent in the Claude Code held-turn shape (fake_acp.mjs --held-turn), for the attention watcher tests. No model calls.' });
