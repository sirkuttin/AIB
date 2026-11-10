/**
 * xml.etree.ElementTree.fromstring() for the small <task-notification> documents agents write (monitor.apply_notifications):
 * a strict, expat-like well-formedness check (undefined entities, stray '<' or '&', ']]>' in text, mismatched or unbound
 * names make it fail, as ParseError does in Python) and the root's direct children with their ElementTree tag and text.
 */

export interface XmlChild {
  tag: string;
  /** Element.text: character data before the first child element, or null when there is none. */
  text: string | null;
}

class XmlError extends Error {}

const NAME_START =
  'A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const NAME_CHARS = NAME_START + '\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040';
const NAME = new RegExp(`[${NAME_START}:][${NAME_CHARS}:]*`, 'uy');
const SPACE = /[ \t\r\n]*/y;
const BAD_CHAR = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/u;
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

interface Scope {
  prefixes: Map<string, string>;
  fallback: string;
}

class Parser {
  i = 0;
  constructor(readonly s: string) {}

  fail(): never {
    throw new XmlError();
  }

  space(): number {
    SPACE.lastIndex = this.i;
    SPACE.exec(this.s);
    const n = SPACE.lastIndex - this.i;
    this.i = SPACE.lastIndex;
    return n;
  }

  name(): string {
    NAME.lastIndex = this.i;
    const m = NAME.exec(this.s);
    if (!m) this.fail();
    this.i = NAME.lastIndex;
    return m[0];
  }

  /** &...; at this.i; returns its text. */
  reference(): string {
    const end = this.s.indexOf(';', this.i);
    if (end < 0) this.fail();
    const body = this.s.slice(this.i + 1, end);
    this.i = end + 1;
    if (body.startsWith('#')) {
      const m = /^#(?:x([0-9a-fA-F]+)|([0-9]+))$/.exec(body);
      if (!m) this.fail();
      const cp = m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2], 10);
      if (!(cp <= 0x10ffff) || BAD_CHAR.test(String.fromCodePoint(cp)) || (cp >= 0xd800 && cp <= 0xdfff)) this.fail();
      return String.fromCodePoint(cp);
    }
    if (!Object.hasOwn(ENTITIES, body)) this.fail();
    return ENTITIES[body];
  }

  qualify(name: string, scope: Scope, isAttribute: boolean): string {
    const parts = name.split(':');
    if (parts.length > 2 || parts.some((p) => p === '')) this.fail();
    if (parts.length === 1) return isAttribute || !scope.fallback ? name : `{${scope.fallback}}${name}`;
    if (parts[0] === 'xml') return `{http://www.w3.org/XML/1998/namespace}${parts[1]}`;
    const uri = scope.prefixes.get(parts[0]);
    if (uri === undefined) this.fail();
    return `{${uri}}${parts[1]}`;
  }

  /** An element starting at '<'; returns [tag, text]. */
  element(parent: Scope): XmlChild & { children: XmlChild[] } {
    this.i++; // '<'
    const rawName = this.name();
    const attrs: [string, string][] = [];
    for (;;) {
      const gap = this.space();
      const c = this.s[this.i];
      if (c === '>' || c === '/') break;
      if (!gap) this.fail();
      const attr = this.name();
      this.space();
      if (this.s[this.i] !== '=') this.fail();
      this.i++;
      this.space();
      const quote = this.s[this.i];
      if (quote !== '"' && quote !== "'") this.fail();
      this.i++;
      let value = '';
      for (;;) {
        const ch = this.s[this.i];
        if (ch === undefined || ch === '<') this.fail();
        if (ch === quote) break;
        if (ch === '&') value += this.reference();
        else {
          value += ch;
          this.i++;
        }
      }
      this.i++;
      if (attrs.some(([n]) => n === attr)) this.fail();
      attrs.push([attr, value]);
    }
    const scope: Scope = { prefixes: new Map(parent.prefixes), fallback: parent.fallback };
    for (const [n, v] of attrs) {
      if (n === 'xmlns') scope.fallback = v;
      else if (n.startsWith('xmlns:')) {
        if (!v) this.fail();
        scope.prefixes.set(n.slice(6), v);
      }
    }
    const seen = new Set<string>();
    for (const [n] of attrs) {
      if (n === 'xmlns' || n.startsWith('xmlns:')) continue;
      const q = this.qualify(n, scope, true);
      if (seen.has(q)) this.fail();
      seen.add(q);
    }
    const tag = this.qualify(rawName, scope, false);
    const node = { tag, text: null as string | null, children: [] as XmlChild[] };
    if (this.s[this.i] === '/') {
      if (this.s[this.i + 1] !== '>') this.fail();
      this.i += 2;
      return node;
    }
    this.i++; // '>'
    let data = '';
    let sawChild = false;
    for (;;) {
      const lt = this.s.indexOf('<', this.i);
      const amp = this.s.indexOf('&', this.i);
      let stop = lt < 0 ? this.s.length : lt;
      if (amp >= 0 && amp < stop) stop = amp;
      const chunk = this.s.slice(this.i, stop);
      if (chunk.includes(']]>')) this.fail();
      if (!sawChild) data += chunk;
      this.i = stop;
      if (this.i >= this.s.length) this.fail();
      if (this.s[this.i] === '&') {
        const text = this.reference();
        if (!sawChild) data += text;
        continue;
      }
      if (this.s.startsWith('</', this.i)) {
        this.i += 2;
        const closing = this.name();
        this.space();
        if (this.s[this.i] !== '>' || closing !== rawName) this.fail();
        this.i++;
        break;
      }
      if (this.s.startsWith('<!--', this.i)) {
        const end = this.s.indexOf('--', this.i + 4);
        if (end < 0 || this.s[end + 2] !== '>') this.fail();
        this.i = end + 3;
        continue;
      }
      if (this.s.startsWith('<![CDATA[', this.i)) {
        const end = this.s.indexOf(']]>', this.i + 9);
        if (end < 0) this.fail();
        if (!sawChild) data += this.s.slice(this.i + 9, end);
        this.i = end + 3;
        continue;
      }
      if (this.s.startsWith('<?', this.i)) {
        this.i += 2;
        const target = this.name();
        if (target.toLowerCase() === 'xml' || target.includes(':')) this.fail();
        const end = this.s.indexOf('?>', this.i);
        if (end < 0) this.fail();
        if (end > this.i && !/^[ \t\r\n]/.test(this.s[this.i])) this.fail();
        this.i = end + 2;
        continue;
      }
      if (this.s[this.i + 1] === '!') this.fail();
      const child = this.element(scope);
      node.children.push({ tag: child.tag, text: child.text });
      if (!sawChild) node.text = data.length ? data : null;
      sawChild = true;
    }
    if (!sawChild) node.text = data.length ? data : null;
    return node;
  }
}

/** The root's direct children, or null where ElementTree raises ParseError. */
export function parseNotice(xml: string): { tag: string; children: XmlChild[] } | null {
  const text = xml.replace(/\r\n?/g, '\n');
  if (BAD_CHAR.test(text) || /[\uD800-\uDFFF]/u.test(text)) return null;
  const parser = new Parser(text);
  try {
    if (text[0] !== '<') return null;
    const root = parser.element({ prefixes: new Map(), fallback: '' });
    parser.space();
    if (parser.i !== text.length) return null;
    return { tag: root.tag, children: root.children };
  } catch (error) {
    if (error instanceof XmlError) return null;
    throw error;
  }
}

/** Element.findtext(tag) on the root: first direct child's text ('' when it has none), or null. */
export function findtext(children: XmlChild[], tag: string): string | null {
  const found = children.find((c) => c.tag === tag);
  return found ? found.text ?? '' : null;
}
