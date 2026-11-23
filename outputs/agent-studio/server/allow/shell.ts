/**
 * Allow rules: strict shell readers for bash and PowerShell. They never run anything and never touch the disk. A command reads as
 * a list of parts (simple commands joined by && || ; | or a newline), each a list of constant words. Anything that could expand,
 * run something or hide a part (variables, $( ), backticks, braces, globs that could match "..", here-docs, redirections other
 * than to /dev/null, subshells, background &, comments, leading assignments, line continuations, non-ASCII in PowerShell) makes
 * the whole command unreadable, and an unreadable command always asks (fail closed: architect review 2.3, 2.4, 2.5).
 *
 * PowerShell: phase 1 uses this strict reader, not PowerShell's own AST. It accepts only plain cmdlet words, -Parameters, bare
 * words and quoted constants, so every construct the review lists ((...) arguments, .Method(), @splat, --%, backticks, script
 * blocks, $vars, Unicode dashes and smart quotes) is refused rather than understood.
 */

export interface Part {
  /** The words of one simple command, quotes removed. */
  words: string[];
  /** Per word: it holds an unquoted glob character (* ? [). */
  globs: boolean[];
}

export type Parsed = { ok: true; parts: Part[] } | { ok: false; reason: string };

const fail = (reason: string): Parsed => ({ ok: false, reason });

/** Bash: the parts of a command, or why it can't be read. */
export function parseBash(source: string): Parsed {
  if (source.length > 4000) return fail('command too long');
  // deno-lint-ignore no-control-regex -- refusing control characters is the point
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(source)) return fail('control characters');
  // deno-lint-ignore no-control-regex -- refusing what another shell could read differently is the point (review H10)
  if (/[^\x09\x0a\x20-\x7e]/.test(source)) return fail('non-ASCII characters (another shell could read them differently)');
  const parts: Part[] = [];
  let words: string[] = [];
  let globs: boolean[] = [];
  let word = '';
  let inWord = false;
  let glob = false;
  let i = 0;
  const endWord = () => {
    if (inWord) {
      words.push(word);
      globs.push(glob);
    }
    word = '';
    inWord = false;
    glob = false;
  };
  const endPart = (): string => {
    endWord();
    if (!words.length) return 'empty command part';
    parts.push({ words, globs });
    words = [];
    globs = [];
    return '';
  };
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t') {
      endWord();
      i++;
      continue;
    }
    if (c === '\n' || c === ';') {
      if (c === '\n' && !inWord && !words.length) { // blank lines between parts
        i++;
        continue;
      }
      const why = endPart();
      if (why) return fail(why);
      i++;
      continue;
    }
    if (c === '&') {
      if (source[i + 1] !== '&') return fail('background &');
      const why = endPart();
      if (why) return fail(why);
      i += 2;
      continue;
    }
    if (c === '|') {
      if (source[i + 1] === '&') return fail('|&');
      const why = endPart();
      if (why) return fail(why);
      i += source[i + 1] === '|' ? 2 : 1;
      continue;
    }
    if (c === '>' || c === '<') {
      // Only the harmless redirections: 2>/dev/null, >/dev/null, 2>&1.
      const rest = source.slice(i);
      const fd = inWord && /^[12]$/.test(word) ? word : '';
      if (inWord && !fd) return fail('redirection');
      const m = /^(>|>>)(?:[ \t]*\/dev\/null(?=[\s;|&]|$)|&1(?=[\s;|&]|$))/.exec(rest);
      if (c === '<' || !m) return fail(c === '<' ? 'input redirection or here-doc' : 'redirection to a file');
      if (m[0].endsWith('&1') && fd !== '2') return fail('redirection');
      word = '';
      inWord = false;
      glob = false;
      i += m[0].length;
      continue;
    }
    if (c === '#' && !inWord) return fail('comment');
    if ('$`(){}'.includes(c)) {
      return fail(c === '$' ? 'expansion' : c === '`' ? 'backticks' : c === '{' || c === '}' ? 'braces' : 'subshell');
    }
    if (c === '!' && !inWord) return fail('history or negation');
    if (c === '~' && !inWord) return fail('tilde');
    if (c === '\\') {
      const next = source[i + 1];
      if (next === undefined || next === '\n') return fail('line continuation');
      word += next;
      inWord = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = source.indexOf("'", i + 1);
      if (end < 0) return fail('unclosed quote');
      word += source.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = '';
      for (; j < source.length && source[j] !== '"'; j++) {
        const d = source[j];
        if (d === '$' || d === '`') return fail('expansion in double quotes');
        if (d === '\\') {
          const e = source[j + 1];
          if (e === undefined || e === '\n') return fail('line continuation');
          if ('"\\'.includes(e)) {
            text += e;
            j++;
            continue;
          }
          text += d;
          continue;
        }
        if (d === '!') return fail('history expansion');
        text += d;
      }
      if (j >= source.length) return fail('unclosed quote');
      word += text;
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === '*' || c === '?' || c === '[') glob = true;
    if (c === '=' && !words.length && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) return fail('leading assignment');
    word += c;
    inWord = true;
    i++;
  }
  endWord();
  if (words.length) parts.push({ words, globs });
  else if (parts.length && /(&&|\|\||\|)\s*$/.test(source)) return fail('command ends with an operator');
  if (!parts.length) return fail('empty command');
  return { ok: true, parts };
}

/** PowerShell (strict reader, see the file comment): the parts, or why it can't be read. */
export function parsePwsh(source: string): Parsed {
  if (source.length > 4000) return fail('command too long');
  // deno-lint-ignore no-control-regex -- refusing control characters is the point
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(source)) return fail('non-ASCII characters (PowerShell reads some as dashes or quotes)');
  const parts: Part[] = [];
  let words: string[] = [];
  let globs: boolean[] = [];
  let word = '';
  let inWord = false;
  let glob = false;
  let i = 0;
  const endWord = () => {
    if (inWord) {
      words.push(word);
      globs.push(glob);
    }
    word = '';
    inWord = false;
    glob = false;
  };
  const endPart = (): string => {
    endWord();
    if (!words.length) return 'empty command part';
    parts.push({ words, globs });
    words = [];
    globs = [];
    return '';
  };
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    if (c === '\n' || c === ';' || c === '|' || (c === '&' && source[i + 1] === '&')) {
      if (c === '\n' && !inWord && !words.length) {
        i++;
        continue;
      }
      const why = endPart();
      if (why) return fail(why);
      i += (c === '&' || (c === '|' && source[i + 1] === '|')) ? 2 : 1;
      continue;
    }
    if (c === "'") {
      const end = source.indexOf("'", i + 1);
      if (end < 0) return fail('unclosed quote');
      if (source[end + 1] === "'") return fail('escaped quote');
      word += source.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const end = source.indexOf('"', i + 1);
      if (end < 0) return fail('unclosed quote');
      const text = source.slice(i + 1, end);
      if (/[$`]/.test(text)) return fail('expansion in double quotes');
      word += text;
      inWord = true;
      i = end + 1;
      continue;
    }
    if ('$`(){}@&<>#[],!'.includes(c)) return fail(`"${c}" in a PowerShell command`);
    if (c === '-' && source.startsWith('--%', i)) return fail('--%');
    if (c === '.' && !inWord && /^\.[\s]/.test(source.slice(i))) return fail('dot-sourcing');
    if (c === '*' || c === '?') glob = true;
    if (c === '=' && !words.length) return fail('assignment');
    word += c;
    inWord = true;
    i++;
  }
  endWord();
  if (words.length) parts.push({ words, globs });
  if (!parts.length) return fail('empty command');
  for (const p of parts) {
    // A method call or member access on a bare word: x.Method or a .NET type.
    if (p.words.some((w) => /\.[A-Za-z_]+\(/.test(w))) return fail('method call');
  }
  return { ok: true, parts };
}

/** Split a Windows command line into words (double quotes group; backslashes before a quote escape it). */
export function splitWindows(line: string): string[] | null {
  const out: string[] = [];
  let word = '';
  let inWord = false;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      let n = 0;
      while (line[i + n] === '\\') n++;
      if (line[i + n] === '"') {
        word += '\\'.repeat(Math.floor(n / 2));
        if (n % 2) {
          word += '"';
          i += n;
        } else i += n - 1;
      } else {
        word += '\\'.repeat(n);
        i += n - 1;
      }
      inWord = true;
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
      inWord = true;
      continue;
    }
    if ((c === ' ' || c === '\t') && !quoted) {
      if (inWord) out.push(word);
      word = '';
      inWord = false;
      continue;
    }
    word += c;
    inWord = true;
  }
  if (quoted) return null;
  if (inWord) out.push(word);
  return out;
}

/**
 * codex-acp's Windows wrapper (extractWrappedScript): `powershell.exe [-NoLogo] [-NoProfile] -Command|-c <script>`. Returns the
 * inner script, or null when the string is not exactly that wrapper.
 */
export function unwrapCodexPowershell(command: string): string | null {
  // codex-acp shows a script without a single quote as `pwsh.exe -Command '<script>'` (its display join): one single-quoted script
  const single = /^("[^"]*"|[^\s"']+)\s+((?:-NoLogo\s+|-NoProfile\s+)*)-(?:Command|c)\s+'([^']*)'$/i.exec(command.trim());
  if (single) {
    const exe = single[1].replace(/^"|"$/g, '').replaceAll('/', '\\').split('\\').pop()!.toLowerCase();
    return ['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(exe) ? single[3] : null;
  }
  const words = splitWindows(command.trim());
  if (!words || words.length < 3) return null;
  const exe = words[0].replaceAll('/', '\\').split('\\').pop()!.toLowerCase();
  if (!['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(exe)) return null;
  let i = 1;
  while (i < words.length && ['-nologo', '-noprofile'].includes(words[i].toLowerCase())) i++;
  if (i >= words.length || !['-command', '-c'].includes(words[i].toLowerCase())) return null;
  const rest = words.slice(i + 1);
  if (rest.length !== 1) return null; // one script argument only; anything after it would be read by PowerShell too
  return rest[0];
}
