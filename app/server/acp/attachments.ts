/** Validation of image and file attachments on a prompt, and their mapping to ACP content blocks (attachments.py). */
import { createHash } from 'node:crypto';
import { clip, isDict, isStr, pyB64Decode, pyLen, pyRepr, pyStrip, ValueError } from '../core/py.ts';

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_EVENT_IMAGE_BYTES = 32 * 1024 * 1024;

type Dict = Record<string, unknown>;

const startsWith = (raw: Uint8Array, prefix: number[]) => raw.length >= prefix.length && prefix.every((b, i) => raw[i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

const SIGNATURES: Record<string, (raw: Uint8Array) => boolean> = {
  'image/png': (b) => startsWith(b, [0x89, ...ascii('PNG\r\n\x1a\n')]),
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/gif': (b) => startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a')),
  'image/webp': (b) => b.length >= 12 && startsWith(b, ascii('RIFF')) && startsWith(b.subarray(8, 12), ascii('WEBP')),
};

const extraKeys = (item: Dict, allowed: string[]) => Object.keys(item).some((k) => !allowed.includes(k));

/** len(s) > limit in code points, without walking strings that are clearly short. */
const longer = (value: string, limit: number) => value.length > limit && pyLen(value) > limit;

/** Python's `x in some_dict_or_set` raises TypeError for an unhashable list or dict. */
function hashable(value: unknown): void {
  if (Array.isArray(value)) throw new TypeError("unhashable type: 'list'");
  if (isDict(value)) throw new TypeError("unhashable type: 'dict'");
}

export interface ImageBlock {
  type: 'image';
  mimeType: string;
  data: string;
}

/** Validate image attachments (PNG, JPEG, GIF, WebP as base64). Returns [blocks, total decoded bytes]. */
export function validateImageAttachments(attachments: unknown): [ImageBlock[], number] {
  if (!Array.isArray(attachments) || attachments.length < 1 || attachments.length > MAX_IMAGES) {
    throw new ValueError(`Attach between 1 and ${MAX_IMAGES} images`);
  }
  const validated: ImageBlock[] = [];
  let total = 0;
  for (const item of attachments) {
    if (!isDict(item) || extraKeys(item, ['type', 'mimeType', 'data']) || (Object.hasOwn(item, 'type') ? item.type : 'image') !== 'image') {
      throw new ValueError('Each image must contain only mimeType and base64 data');
    }
    const mime = item.mimeType;
    const encoded = item.data;
    hashable(mime);
    if (!isStr(mime) || !Object.hasOwn(SIGNATURES, mime)) throw new ValueError('Images must be PNG, JPEG, GIF, or WebP');
    if (!isStr(encoded) || !encoded || longer(encoded, 4 * Math.floor((MAX_IMAGE_BYTES + 2) / 3))) {
      throw new ValueError('Image data is empty or exceeds the 5 MiB limit');
    }
    const raw = pyB64Decode(encoded);
    if (raw === null) throw new ValueError('Image data must be valid base64');
    if (!raw.length || raw.length > MAX_IMAGE_BYTES) throw new ValueError('Image data is empty or exceeds the 5 MiB limit');
    if (!SIGNATURES[mime](raw)) throw new ValueError(`Image data does not match ${mime}`);
    total += raw.length;
    if (total > MAX_TOTAL_IMAGE_BYTES) throw new ValueError('Images exceed the 15 MiB total limit');
    validated.push({ type: 'image', mimeType: mime, data: encoded });
  }
  return [validated, total];
}

// ---- File (non-image) attachments -------------------------------------------------------------
export const MAX_FILES = 8;
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_BINARY_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024; // images and files together
export const MAX_PROMPT_BODY_BYTES = 30 * 1024 * 1024; // 20 MiB as base64 (26.7 MiB) plus names and typed text
export const MAX_EVENT_FILE_PREVIEW_CHARS = 4000;
export const MAX_FILE_NAME_CHARS = 200;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const TEXT_MIME_EXACT = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'application/typescript',
  'application/x-typescript',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/sql',
  'application/x-sql',
  'application/x-sh',
  'application/x-httpd-php',
  'application/xhtml+xml',
  'application/x-ndjson',
  'application/csv',
  'application/x-python',
  'application/x-python-code',
  'application/x-ruby',
]);
const NEUTRAL_MIMES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const BINARY_ONLY_MIMES = new Set([
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
]);
const TEXT_EXTENSIONS: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  ndjson: 'application/x-ndjson',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  py: 'text/x-python',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  sql: 'application/sql',
  sh: 'application/x-sh',
  ini: 'text/plain',
  cfg: 'text/plain',
  conf: 'text/plain',
  env: 'text/plain',
  rs: 'text/x-rust',
  go: 'text/x-go',
  java: 'text/x-java',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
  cs: 'text/x-csharp',
  rb: 'text/x-ruby',
  php: 'text/x-php',
  swift: 'text/x-swift',
  kt: 'text/x-kotlin',
  ps1: 'text/plain',
  bat: 'text/plain',
  svg: 'image/svg+xml',
  diff: 'text/x-diff',
  patch: 'text/x-diff',
  tex: 'text/x-tex',
  rst: 'text/x-rst',
};
const BINARY_EXTENSIONS: Record<string, string> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const PICTURE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const lookup = (table: Record<string, string>, key: string) => (Object.hasOwn(table, key) ? table[key] : undefined);

const UNSAFE_CATEGORY = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;

/** Names are display-only labels. Anything that could look like a path, drive, device or control sequence is refused. */
export function validateAttachmentName(name: unknown): string {
  if (!isStr(name) || !pyStrip(name)) throw new ValueError('Each file needs a name');
  if (longer(name, MAX_FILE_NAME_CHARS)) throw new ValueError(`File name is longer than ${MAX_FILE_NAME_CHARS} characters`);
  const shown = pyRepr(clip(name, 40));
  if (name !== pyStrip(name) || pyStrip(name, '.') === '' || name.endsWith('.')) {
    throw new ValueError(`File name ${shown} is not allowed (leading/trailing space, dots only, or trailing dot)`);
  }
  if (UNSAFE_CATEGORY.test(name)) throw new ValueError(`File name ${shown} contains control, invisible or direction-changing characters`);
  if ([...'/\\:<>"|?*'].some((ch) => name.includes(ch))) {
    throw new ValueError(`File name ${shown} must not contain path separators or any of : < > " | ? *`);
  }
  return name;
}

function normalMime(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (!isStr(value)) throw new ValueError('File type must be a string');
  const mime = pyStrip(value.split(';', 1)[0]).toLowerCase();
  if (mime && !MIME_PATTERN.test(mime)) throw new ValueError(`File type ${pyRepr(clip(value, 60))} is not a valid MIME type`);
  return mime;
}

function extension(name: string): string {
  return pyStrip(name, '.').includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
}

const isTextMime = (mime: string) =>
  mime.startsWith('text/') || TEXT_MIME_EXACT.has(mime) || mime.endsWith('+json') || mime.endsWith('+xml');

/** Valid UTF-8 without NUL bytes, or null. A leading byte-order mark is dropped. */
function decodeText(raw: Uint8Array): string | null {
  if (raw.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return null;
  }
}

export type FileKind = 'text' | 'audio' | 'binary';

/** Return [kind, mimeType, text] where kind is 'text', 'audio' or 'binary'. Never reads or writes the disk. */
export function classifyFile(name: string, declaredMime: unknown, raw: Uint8Array): [FileKind, string, string | null] {
  let mime = normalMime(declaredMime);
  const ext = extension(name);
  const major = mime.split('/', 1)[0];
  let text: string | null = null;
  const couldBeText = mime === 'image/svg+xml' ||
    (!BINARY_ONLY_MIMES.has(mime) && !['image', 'audio', 'video', 'font'].includes(major) &&
      (isTextMime(mime) || (NEUTRAL_MIMES.has(mime) && !Object.hasOwn(BINARY_EXTENSIONS, ext)) || Object.hasOwn(TEXT_EXTENSIONS, ext)));
  if (couldBeText) text = decodeText(raw);
  if (text !== null) {
    return ['text', isTextMime(mime) || mime === 'image/svg+xml' ? mime : lookup(TEXT_EXTENSIONS, ext) ?? 'text/plain', text];
  }
  if (!mime || NEUTRAL_MIMES.has(mime)) mime = lookup(BINARY_EXTENSIONS, ext) ?? 'application/octet-stream';
  return [mime.startsWith('audio/') ? 'audio' : 'binary', mime, null];
}

export interface FileRecord {
  name: string;
  mimeType: string;
  size: number;
  kind: FileKind;
  text: string | null;
  data: string | null;
  sha256: string;
}

/** Validate non-image attachments: {type: 'file', name, mimeType, data: base64}. Returns [records, total bytes]. */
export function validateFileAttachments(attachments: unknown): [FileRecord[], number] {
  if (!Array.isArray(attachments) || attachments.length < 1 || attachments.length > MAX_FILES) {
    throw new ValueError(`Attach between 1 and ${MAX_FILES} files`);
  }
  const records: FileRecord[] = [];
  let total = 0;
  for (const item of attachments) {
    if (!isDict(item) || extraKeys(item, ['type', 'name', 'mimeType', 'data']) || item.type !== 'file') {
      throw new ValueError('Each file must contain only type "file", name, mimeType and base64 data');
    }
    const name = validateAttachmentName(item.name);
    const declared = normalMime(item.mimeType);
    if (PICTURE_MIMES.has(declared)) throw new ValueError(`${name}: attach PNG, JPEG, GIF and WebP pictures as images, not as files`);
    const encoded = item.data;
    if (!isStr(encoded) || !encoded || longer(encoded, 4 * Math.floor((MAX_BINARY_FILE_BYTES + 2) / 3))) {
      throw new ValueError(`${name}: file is empty or exceeds the ${MAX_BINARY_FILE_BYTES / 1048576} MiB limit`);
    }
    const raw = pyB64Decode(encoded);
    if (raw === null) throw new ValueError(`${name}: file data must be valid base64`);
    if (!raw.length) throw new ValueError(`${name}: file is empty`);
    const [kind, mime, text] = classifyFile(name, declared, raw);
    const limit = kind === 'text' ? MAX_TEXT_FILE_BYTES : MAX_BINARY_FILE_BYTES;
    if (raw.length > limit) throw new ValueError(`${name}: ${kind} file exceeds the ${Math.floor(limit / 1048576)} MiB limit`);
    total += raw.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new ValueError(`Attachments exceed the ${MAX_TOTAL_ATTACHMENT_BYTES / 1048576} MiB total limit`);
    }
    records.push({
      name,
      mimeType: mime,
      size: raw.length,
      kind,
      text,
      data: kind === 'text' ? null : encoded,
      sha256: createHash('sha256').update(raw).digest('hex'),
    });
  }
  return [records, total];
}

/** Separate the image items (type 'image' or untyped, as before) from the file items. */
export function splitAttachments(attachments: unknown): [Dict[], Dict[]] {
  if (!Array.isArray(attachments)) throw new ValueError('Attachments must be a list');
  const images: Dict[] = [];
  const files: Dict[] = [];
  for (const item of attachments) {
    const kind = isDict(item) ? (Object.hasOwn(item, 'type') ? item.type : 'image') : null;
    if (kind === 'image') images.push(item);
    else if (kind === 'file') files.push(item);
    else throw new ValueError('Each attachment must be an image or a file');
  }
  return [images, files];
}

/** One decimal like Python's f'{x:.1f}': ties on the exact binary value round to even (toFixed rounds them up). */
function oneDecimal(x: number): string {
  const tenths = x * 10;
  const floor = Math.floor(tenths);
  if (tenths - floor !== 0.5) return x.toFixed(1);
  const n = floor % 2 === 0 ? floor : floor + 1;
  return `${Math.floor(n / 10)}.${n % 10}`;
}

export function formatSize(count: number): string {
  return count < 1024 ? `${count} B` : count < 1048576 ? `${oneDecimal(count / 1024)} KB` : `${oneDecimal(count / 1048576)} MB`;
}

function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** urllib.parse.quote(value, safe=''): only letters, digits and _.-~ stay unescaped. */
function quote(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export interface FileSummary {
  name: string;
  mimeType: string;
  size: number;
  kind: FileKind;
  mode?: 'embedded' | 'inline' | 'audio';
  preview?: string;
  truncated?: boolean;
}

/**
 * Map validated files to ACP content blocks according to the agent's promptCapabilities. Returns [blocks, summaries];
 * throws one ValueError naming every file the agent cannot take. Nothing is dropped silently.
 */
export function mapFileAttachments(records: FileRecord[], promptCapabilities: unknown): [Dict[], FileSummary[]] {
  const caps = isDict(promptCapabilities) ? promptCapabilities : {};
  const embedded = caps.embeddedContext === true;
  const audio = caps.audio === true;
  const blocks: Dict[] = [];
  const summaries: FileSummary[] = [];
  const refused: string[] = [];
  records.forEach((record, index) => {
    const { name, mimeType: mime, kind } = record;
    const uri = `attachment:///${index + 1}/${quote(name)}`;
    const summary: FileSummary = { name, mimeType: mime, size: record.size, kind };
    if (kind === 'text') {
      const text = record.text as string;
      if (embedded) {
        blocks.push({ type: 'resource', resource: { uri, mimeType: mime, text } });
        summary.mode = 'embedded';
      } else {
        const marks = fence(text);
        const body = text.endsWith('\n') ? text : text + '\n';
        blocks.push({ type: 'text', text: `Attached file: ${name} (${mime}, ${formatSize(record.size)})\n${marks}\n${body}${marks}` });
        summary.mode = 'inline';
      }
      summary.preview = clip(text, MAX_EVENT_FILE_PREVIEW_CHARS);
      summary.truncated = longer(text, MAX_EVENT_FILE_PREVIEW_CHARS);
    } else if (kind === 'audio' && audio) {
      blocks.push({ type: 'audio', mimeType: mime, data: record.data });
      summary.mode = 'audio';
    } else if (embedded) {
      blocks.push({ type: 'resource', resource: { uri, mimeType: mime, blob: record.data } });
      summary.mode = 'embedded';
    } else {
      const need = kind === 'audio'
        ? 'audio input (promptCapabilities.audio) or embedded context (promptCapabilities.embeddedContext)'
        : 'embedded context (promptCapabilities.embeddedContext)';
      refused.push(
        `${name} (${mime}): this agent does not advertise ${need}, so it cannot take this ${kind === 'audio' ? 'audio' : 'binary'} file`,
      );
    }
    summaries.push(summary);
  });
  if (refused.length) throw new ValueError(refused.join('; ') + '. Text files can still be attached.');
  return [blocks, summaries];
}

/** Characters of image data a stored event holds (counted against MAX_EVENT_IMAGE_BYTES). */
export function eventImageSize(event: Dict): number {
  const data = Object.hasOwn(event, 'data') ? event.data : {};
  const attachments = isDict(data) ? (Object.hasOwn(data, 'attachments') ? data.attachments : []) : [];
  if (!Array.isArray(attachments)) {
    if (isStr(attachments) || isDict(attachments)) return 0;
    throw new TypeError(
      `'${attachments === null ? 'NoneType' : typeof attachments === 'boolean' ? 'bool' : 'int'}' object is not iterable`,
    );
  }
  let total = 0;
  for (const item of attachments) if (isDict(item) && isStr(item.data)) total += pyLen(item.data);
  return total;
}
