'use strict';
/* A tiny CSS reader for tests, so they check what a stylesheet says (selector -> declarations) and not how it is spelled:
   whitespace, line breaks, selector-list layout and a trailing semicolon do not matter, so a Prettier pass over the CSS
   leaves the tests green. It handles plain rules and rules nested one level in an at-rule such as @media; it does not
   evaluate the at-rule's condition. Not a test file: node --test work/test_*.js does not pick it up. */

const collapse = (text) => text.replace(/\s+/g, ' ').trim();
const squash = (text) => text.replace(/\s+/g, ''); // an at-rule condition compared without spaces: "(hover:none)" equals "(hover: none)"

/* [{ selector, declarations: { property: value }, context }] with one entry per selector of a comma list.
   `context` is the enclosing at-rule prelude without spaces ("@media(hover:none)") or '' for a top-level rule. */
function cssRules(css) {
  const text = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const walk = (block, context) => {
    const pattern = /([^{}]+)\{/g;
    let match;
    while ((match = pattern.exec(block))) {
      const prelude = collapse(match[1]);
      let depth = 1,
        end = pattern.lastIndex;
      while (end < block.length && depth) {
        if (block[end] === '{') depth++;
        else if (block[end] === '}') depth--;
        end++;
      }
      const body = block.slice(pattern.lastIndex, end - 1);
      if (prelude.startsWith('@')) walk(body, squash(prelude));
      else {
        const declarations = {};
        for (const part of body.split(';')) {
          const colon = part.indexOf(':');
          if (colon > 0)
            declarations[collapse(part.slice(0, colon)).toLowerCase()] = collapse(part.slice(colon + 1)).replace(
              /\s*!\s*important$/i,
              ' !important',
            );
        }
        for (const selector of prelude.split(',')) rules.push({ selector: collapse(selector), declarations, context });
      }
      pattern.lastIndex = end;
    }
  };
  walk(text, '');
  return rules;
}

/* The declarations that apply to exactly this selector, merged in stylesheet order. Optionally only rules outside any
   at-rule (context === '') or inside the given one. */
function declarationsFor(rules, selector, context = '') {
  const wanted = collapse(selector);
  return Object.assign(
    {},
    ...rules
      .filter((rule) => rule.selector === wanted && rule.context === squash(context))
      .map((rule) => rule.declarations),
  );
}

module.exports = { cssRules, declarationsFor };
