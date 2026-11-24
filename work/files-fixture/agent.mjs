// Fixture agent for the file-attachments browser check. Reads files-fixture/mode.txt at start (words: images embedded audio); no model calls.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../fakes/fake_acp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modeFile = path.join(here, 'mode.txt');
const mode = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').split(/\s+/).filter(Boolean) : ['images', 'embedded', 'audio'];
run([...(mode.includes('images') ? ['--images'] : []), ...(mode.includes('embedded') ? ['--embedded-context'] : []), ...(mode.includes('audio') ? ['--audio'] : [])]);
