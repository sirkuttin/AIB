/**
 * WSL audit (docs/wsl/audit-beta10.md), server side of paths in WSL chats: what AIB answers when the page sends it a bare Linux
 * path (the page's path links do, see work/audit_wsl_page_links.js). These tests pin today's answers (clean refusals, nothing
 * read on the Windows disk); the messages are what the user sees.
 */
import { assertEquals, assertThrows } from './_assert.ts';
import { cleanPathText, EditorError, resolveWslInside } from '../../outputs/agent-studio/server/desktop/editors.ts';
import { checkShape } from '../../outputs/agent-studio/server/worktrees/outside_files.ts';
import { FilesError } from '../../outputs/agent-studio/server/worktrees/files.ts';

const WIN = Deno.build.os === 'windows';
const REF = 'wsl://ubuntu/home/u/app';

Deno.test({
  name: 'editors: Ctrl+click on a bare Linux path (an outside link in a WSL chat) is refused with "That path is not a folder of this PC"',
  ignore: !WIN,
  fn() {
    const e = assertThrows(() => cleanPathText('/home/u/other/run.log'), EditorError) as EditorError;
    assertEquals(e.message, 'That path is not a folder of this PC');
    // even as a ref, a file outside every known project is refused (outside links can never open in an editor)
    const r = assertThrows(() => resolveWslInside('wsl://ubuntu/home/u/other/run.log', [REF]), EditorError) as EditorError;
    assertEquals(r.message, 'That location is not inside a project folder AIB knows, so AIB will not open it');
    // a ref inside the project is opened
    assertEquals(resolveWslInside(REF + '/README.md', [REF]).linuxPath, '/home/u/app/README.md');
  },
});

Deno.test({
  name: 'files/outside for a WSL chat that is not live in this process: the Windows branch answers "Network and device paths are not supported"',
  ignore: !WIN,
  fn() {
    // files_routes.ts wslChatLoc only knows live connections; any other id goes to checkShape, which refuses a Linux path
    const e = assertThrows(() => checkShape('/home/u/app/README.md'), FilesError) as FilesError;
    assertEquals(e.message, 'Network and device paths are not supported');
  },
});
