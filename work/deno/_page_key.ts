/**
 * The page's launch key for one test run (server/web/page_access.ts): bootstrap hands out the page token only with it, as it does
 * to the app's own window. Put in this process's environment (AIB_PAGE_KEY), so every AIB a test starts as a process gets it, and an
 * in-process server of a test run (AGENT_STUDIO_TEST=1) uses it too. A browser page gets it in its link (`#aib-key=`: withPageKey).
 */
const given = Deno.env.get('AIB_PAGE_KEY') ?? '';
/** AIB_PAGE_KEY when it is already set (the site-shots scripts against a demo AIB: its <demo>/page-key.txt), else a new one. */
export const PAGE_KEY = /^[A-Za-z0-9_-]{32,128}$/.test(given) ? given : 'test-page-key-' + crypto.randomUUID().replaceAll('-', '');
Deno.env.set('AIB_PAGE_KEY', PAGE_KEY);

/** A page URL of a test AIB with the launch key in its fragment (chat.html, doc.html, `/`); any other URL as it is. */
export function withPageKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    return url;
  }
  if (
    !['/', '/chat.html', '/doc.html'].includes(parsed.pathname) || parsed.hash
  ) return url;
  return `${url}#aib-key=${PAGE_KEY}`;
}
