// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';

// The site's public address (likely address, not final yet): change it here, in this one place.
export const SITE = 'https://aib.softsirkut.com';
// Where the downloads and the source live.
export const REPO = 'https://github.com/sirkuttin/AIB';

export default defineConfig({
  site: SITE,
  integrations: [
    starlight({
      // Fails the build on a broken link between pages.
      plugins: [starlightLinksValidator({ errorOnLocalLinks: false })],
      title: 'AIB',
      description:
        'AIB, the Agent Integration Bay: every coding agent in one window, on your own PC. Claude Code, Codex, OMP and ten more, with shared docs, artifacts, one inbox and a phone remote. No account, no cloud service of ours.',
      logo: { src: './src/assets/aib-logo.svg', alt: 'AIB' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'AIB on GitHub', href: REPO }],
      customCss: ['./src/styles/aib.css'],
      lastUpdated: false,
      // src/content/docs/404.md is the not-found page; it is built by the docs route.
      disable404Route: true,
      pagination: true,
      sidebar: [
        {
          label: 'Start',
          items: [{ label: 'Home', link: '/' }, 'download', 'start'],
        },
        {
          label: 'Features',
          items: [
            'agents',
            'chats',
            'inbox',
            'steering',
            'worktrees',
            'docs',
            'artifacts',
            'files',
            'private-folder',
            'keeper',
            'updates',
            'limits',
            'themes',
          ],
        },
        {
          label: 'Phone',
          items: ['phone', 'phone/setup'],
        },
        {
          label: 'Reference',
          items: ['shortcuts', 'how-it-works', 'privacy', 'faq', 'troubleshooting', 'limits-and-status'],
        },
        {
          label: 'Project',
          items: ['releases', 'contributing'],
        },
      ],
    }),
  ],
});
