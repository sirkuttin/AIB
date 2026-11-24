// Fake ACP agent with every fixture feature enabled, for checking the merged UI. No model calls.
import { launchFake } from '../fakes/_launch.mjs';

launchFake(['--images', '--rich', '--breadth', '--subagent', '--list-sessions'], { doc: 'Fake ACP agent with every fixture feature enabled, for checking the merged UI. No model calls.' });
