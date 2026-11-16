'use strict';
// node work/qa_wsl/smoke.js <kind> <scenario> [theme] [width]: one screen, screenshot into dist/.scratch/qa-wsl/smoke.png
const path = require('node:path'),
  fs = require('node:fs');
const { launch } = require('./browser');
const P = require('./pages');
(async () => {
  const [kind = 'settings', scen = 'good', theme = 'teal-dark', width = '1280'] = process.argv.slice(2);
  const scratch = path.join(__dirname, '..', '..', 'dist', '.scratch', 'qa-wsl');
  fs.mkdirSync(scratch, { recursive: true });
  const b = await launch(scratch);
  try {
    await b.size(Number(width), 860);
    const url =
      kind === 'mockup'
        ? P.mockup(scratch, theme)
        : kind === 'settings'
          ? P.page(scratch, 'settings', P.SETTINGS_SCRIPTS, path.join(__dirname, 'settings_fixtures.js'), theme)
          : P.page(scratch, 'other', P.OTHER_SCRIPTS, path.join(__dirname, 'other_fixtures.js'), theme);
    const err = await b.goto(url + '#' + scen);
    console.log('error:', err, 'log:', b.log.errors.slice(0, 10), 'dialogs:', b.log.dialogs.map((d) => d.message));
    console.log(await b.evaluate(() => (document.querySelector('.st-content') || document.body).innerText.slice(0, 1500)));
    await b.shot(path.join(scratch, 'smoke.png'));
  } finally {
    console.log('profile removed:', await b.close());
  }
})();
