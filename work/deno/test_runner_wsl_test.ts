/** tools/test.ts: the WSL test files run by default only on Windows; --wsl (or naming one) runs them elsewhere. */
import { assert } from './_assert.ts';
import { testFiles } from '../../tools/test.ts';

const isWsl = (f: string) => /wsl/i.test(f);

Deno.test('off Windows the WSL test files are left out unless asked for', () => {
  assert(testFiles('all', [], false).every((f) => !isWsl(f)), 'a WSL file is in the default list');
  assert(testFiles('all', [], true).some(isWsl), 'the wsl switch lists no WSL file');
  assert(testFiles('all', [], false).length > 0, 'nothing left');
});

Deno.test('naming a WSL file asks for it', () => {
  const named = testFiles('all', ['file_editor_wsl'], false);
  assert(named.length > 0 && named.every(isWsl), 'a named WSL file is not listed');
  assert(testFiles('all', ['files_view'], false).every((f) => !isWsl(f)), 'an other name pulls in WSL files');
});
