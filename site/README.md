# AIB website

The AIB site, built with [Astro Starlight](https://starlight.astro.build). Pages are Markdown/MDX in `src/content/docs/`.

## Build

```sh
cd site
npm install
npm run build      # writes dist/
npm run preview    # serves dist/ locally to look at it
```

The build fails on a broken link between pages. The site loads nothing from other hosts: no web fonts, no analytics, no CDNs.

- Site address: `SITE` in `astro.config.mjs` (one place).
- Screenshots: `src/assets/shots/<name>`. A page names its picture with `<Shot name="…" alt="…" />`; until the file exists,
  the README copy in `docs/screenshots/` is used, or a "Picture coming" box.
- Keyboard shortcuts are read from `outputs/agent-studio/commands-registry.js` at build time.
- Release notes: `src/content/docs/releases.mdx` is made by `scripts/make-releases.py` (see the usage line at its top).

## Deploy

Deploy is manual, from the PC, to Cloudflare Pages with wrangler. Nothing deploys automatically and there is no CI workflow.

```sh
npm run build
npx wrangler pages deploy dist --project-name <project>
```

`dist/` and `node_modules/` are not committed.
