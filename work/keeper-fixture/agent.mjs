// Fake ACP agent for the keeper tests: the plain fixture, cancel-aware (a stream:<n>:<ms> turn streams and asks halfway). No model calls.
import { launchFake } from '../fakes/_launch.mjs';

launchFake(['--cancel-aware'], { doc: 'Fake ACP agent for the keeper tests: the plain fixture, cancel-aware (a stream:<n>:<ms> turn streams and asks halfway). No model calls.' });
