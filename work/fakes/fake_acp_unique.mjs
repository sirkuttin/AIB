// fake_acp.mjs, but every process names its session differently (two chats open at once need different session ids).
import { run } from './fake_acp.mjs';

run(process.argv.slice(2), { fakeSession: `fake-${process.pid}` });
