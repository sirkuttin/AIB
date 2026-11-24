// Fake ACP agent with every fixture feature enabled. No model calls.
import { launchFake } from '../fakes/_launch.mjs';

launchFake(['--images', '--rich', '--breadth', '--subagent', '--list-sessions'], { doc: 'Fake ACP agent with every fixture feature enabled. No model calls.' });
