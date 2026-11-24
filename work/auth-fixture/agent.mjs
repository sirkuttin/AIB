// Deterministic ACP fixture: setup question, then auth required. No model calls.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../fakes/fake_acp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
run(['--setup-question', '--auth-required', '--auth-file', path.join(here, 'login-marker')]);
