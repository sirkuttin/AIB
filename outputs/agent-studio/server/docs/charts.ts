/**
 * Charts (schema.ts `chart`): a bar or line chart that owns its numbers, a small table inside the block (row 0 = series names,
 * column 0 = labels, up to MAX_SERIES series). Every cell is an ordinary table cell with its own id and guard, so an agent's edit to
 * one number is refused when the user changed that number after the agent's read, and lands (marked as the agent's) when they did not.
 *
 *   chartData(node)    the labels and series of a chart's table (cells that are not numbers read as gaps)
 *   chartProblem(node) why a chart's table is not a chart (agent and file edits are refused with it; the user's typing never is)
 *   chartFromTable     a chart node copied once from a table (no live link: later table edits leave the chart alone)
 *   chartSvg(node)     its picture: plain SVG on white, no theme, readable in any viewer (GitHub, an image preview)
 *   syncCharts(doc)    writes docs/<doc>/assets/<chart>.chart.svg for every chart (the .md copy links it), removes pictures of
 *                      charts that are gone; fixChartIds gives a chart without an id (or with a copied one) its own first
 */
import * as Y from 'yjs';
import type { LiveDoc } from './live_doc.ts';
import { jsonOf } from './blocks.ts';
import { chartSrc, expandTable, hasSpans, normalize, type PMJson } from './markdown.ts';
import { CHART_TYPES, MAX_SERIES } from './schema.ts';

const sep = Deno.build.os === 'windows' ? '\\' : '/';
export const CHART_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Rows of data a chart takes (after the series row). */
export const MAX_CHART_ROWS = 50;

export function newChartId(): string {
  return 'chart-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

/** A cell's text (all its paragraphs, plain). */
export function cellText(cell: PMJson | undefined): string {
  const walk = (
    n: PMJson,
  ): string => (n.type === 'text'
    ? n.text ?? ''
    : (n.content ?? []).map(walk).join(n.type === 'tableCell' || n.type === 'tableHeader' ? ' ' : ''));
  return cell ? walk(cell).trim() : '';
}

/** A number cell's value: "3.1", "-2", "1,250", "45%", "$12.50"; null when it is not a number. */
export function parseNumber(text: string): number | null {
  const t = text.trim().replace(/^[$€£¥]/, '').replace(/%$/, '').replace(/(\d),(?=\d{3}(?:\D|$))/g, '$1').trim();
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export interface ChartData {
  labels: string[];
  series: { name: string; values: (number | null)[] }[];
}

/** The table's rows as text (merged cells repeated in each square). */
export function chartRows(table: PMJson): string[][] {
  const t = hasSpans(table) ? expandTable(table) : table;
  return (t.content ?? []).map((r) => (r.content ?? []).map(cellText));
}

export function chartData(node: PMJson): ChartData {
  const rows = chartRows(node.content?.[0] ?? { type: 'table' });
  const head = rows[0] ?? [];
  const body = rows.slice(1);
  return {
    labels: body.map((r) => r[0] ?? ''),
    series: head.slice(1).map((name, k) => ({ name, values: body.map((r) => parseNumber(r[k + 1] ?? '')) })),
  };
}

/** Why the chart is not a chart an agent may leave behind, or null. */
export function chartProblem(node: PMJson): string | null {
  const a = node.attrs ?? {};
  if (!CHART_TYPES.includes(String(a.chartType))) return `"chartType" is ${CHART_TYPES.join(' or ')}`;
  const table = node.content?.[0];
  if (!table) return 'a chart holds one table: its numbers';
  if (hasSpans(table)) return "a chart's table has no merged cells";
  const rows = chartRows(table);
  const cols = rows[0]?.length ?? 0;
  if (cols < 2) return "a chart's table has a label column and at least one series column";
  if (cols - 1 > MAX_SERIES) return `a chart has up to ${MAX_SERIES} series (its table has ${cols - 1})`;
  if (rows.length - 1 > MAX_CHART_ROWS) return `a chart has up to ${MAX_CHART_ROWS} rows of data`;
  for (let r = 1; r < rows.length; r++) {
    for (let c = 1; c < rows[r].length; c++) {
      const v = rows[r][c];
      if (v && parseNumber(v) === null) {
        return `row ${r}, column ${c} ("${v}") is not a number: a chart's cells after the label column hold numbers (or nothing)`;
      }
    }
  }
  return null;
}

const plainCell = (type: string, text: string): PMJson => ({
  type,
  content: [text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' }],
});

/** A chart's table from rows of values (row 0 the series names). Numbers are written as given. */
export function chartTable(rows: unknown[][]): PMJson {
  return {
    type: 'table',
    content: rows.map((r, ri) => ({
      type: 'tableRow',
      content: r.map((v) => plainCell(ri === 0 ? 'tableHeader' : 'tableCell', v === null || v === undefined ? '' : String(v).trim())),
    })),
  };
}

/** A chart copied once from a table: its cells' plain text (merged cells split), its own new id. */
export function chartFromTable(table: PMJson, attrs: { title?: string; chartType?: string; caption?: string } = {}): PMJson {
  return {
    type: 'chart',
    attrs: {
      chart: newChartId(),
      chartType: attrs.chartType ?? 'bar',
      title: attrs.title ?? '',
      caption: attrs.caption ?? '',
    },
    content: [chartTable(chartRows(normalize(table)))],
  };
}

// ---------- the picture ----------

const PALETTE = ['#2563eb', '#ea580c', '#059669', '#9333ea', '#dc2626', '#0891b2'];
const INK = '#1f2328', MUTED = '#57606a', GRID = '#d0d7de';
const W = 640, H = 360;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Tick values from lo to hi with a round step. */
function ticks(lo: number, hi: number): number[] {
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  if (out[out.length - 1] < hi) out.push(out[out.length - 1] + step);
  return out;
}

/** The chart as a standalone SVG (white background, fixed colours: the same in every theme and viewer). */
export function chartSvg(node: PMJson): string {
  const a = node.attrs ?? {};
  const type = a.chartType === 'line' ? 'line' : 'bar';
  const title = String(a.title ?? ''), caption = String(a.caption ?? '');
  const { labels, series } = chartData(node);
  const values = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const t = ticks(Math.min(0, ...values), Math.max(0, ...values, values.length ? -Infinity : 1));
  const lo = t[0], hi = t[t.length - 1];
  const top = (title ? 40 : 16) + (series.length ? 24 : 0);
  const bottom = H - (caption ? 56 : 36);
  const left = 56, right = W - 16;
  const y = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  const n = Math.max(1, labels.length);
  const band = (right - left) / n;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" role="img" aria-label="${
      esc(title || 'Chart')
    }">`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
  ];
  if (title) {
    out.push(
      `<text x="${W / 2}" y="26" text-anchor="middle" font-size="16" font-weight="600" fill="${INK}">${esc(clip(title, 70))}</text>`,
    );
  }
  // legend
  let lx = left;
  series.forEach((s, k) => {
    const ly = top - 14;
    out.push(`<rect x="${lx}" y="${ly - 9}" width="10" height="10" rx="2" fill="${PALETTE[k % PALETTE.length]}"/>`);
    const name = clip(s.name || `Series ${k + 1}`, 24);
    out.push(`<text x="${lx + 14}" y="${ly}" font-size="12" fill="${INK}">${esc(name)}</text>`);
    lx += 14 + name.length * 7 + 18;
  });
  // axis and grid
  for (const v of t) {
    const yy = y(v).toFixed(1);
    out.push(`<line x1="${left}" y1="${yy}" x2="${right}" y2="${yy}" stroke="${v === 0 ? MUTED : GRID}" stroke-width="1"/>`);
    out.push(`<text x="${left - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${MUTED}">${fmt(v)}</text>`);
  }
  labels.forEach((l, i) => {
    out.push(
      `<text x="${(left + band * (i + 0.5)).toFixed(1)}" y="${bottom + 18}" text-anchor="middle" font-size="11" fill="${MUTED}">${
        esc(clip(l, Math.max(4, Math.floor(band / 7))))
      }</text>`,
    );
  });
  const zero = y(Math.max(lo, Math.min(0, hi)));
  if (type === 'bar') {
    const inner = band * 0.8, bw = series.length ? inner / series.length : inner;
    series.forEach((s, k) => {
      s.values.forEach((v, i) => {
        if (v === null) return;
        const x = left + band * i + band * 0.1 + bw * k;
        const y0 = Math.min(y(v), zero), h = Math.abs(zero - y(v));
        out.push(
          `<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${
            PALETTE[k % PALETTE.length]
          }"><title>${esc(`${s.name} · ${labels[i]}: ${fmt(v)}`)}</title></rect>`,
        );
      });
    });
  } else {
    series.forEach((s, k) => {
      const color = PALETTE[k % PALETTE.length];
      // a gap (no number) breaks the line
      let path = '', pen = false;
      s.values.forEach((v, i) => {
        if (v === null) return void (pen = false);
        path += `${pen ? 'L' : 'M'}${(left + band * (i + 0.5)).toFixed(1)} ${y(v).toFixed(1)} `;
        pen = true;
      });
      if (path) {
        out.push(
          `<path d="${path.trim()}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`,
        );
      }
      s.values.forEach((v, i) => {
        if (v === null) return;
        out.push(
          `<circle cx="${(left + band * (i + 0.5)).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5" fill="${color}"><title>${
            esc(`${s.name} · ${labels[i]}: ${fmt(v)}`)
          }</title></circle>`,
        );
      });
    });
  }
  if (caption) {
    out.push(`<text x="${W / 2}" y="${H - 16}" text-anchor="middle" font-size="12" fill="${MUTED}">${esc(clip(caption, 90))}</text>`);
  }
  out.push('</svg>');
  return out.join('\n') + '\n';
}

// ---------- in the doc and on disk ----------

/** The chart blocks of a doc, page by page, in doc order (anywhere: top level, in a column, a toggle, a list item). */
export function chartElements(live: LiveDoc): Y.XmlElement[] {
  const out: Y.XmlElement[] = [];
  const walk = (p: Y.XmlFragment | Y.XmlElement) => {
    for (const c of p.toArray()) {
      if (!(c instanceof Y.XmlElement)) continue;
      if (c.nodeName === 'chart') out.push(c);
      else walk(c);
    }
  };
  for (const { frag } of live.pageFrags()) walk(frag);
  return out;
}

/** Every chart gets an id of its own: a chart made in the page without one, or a copy that took another's id, gets a new one. */
export function fixChartIds(live: LiveDoc): void {
  const seen = new Set<string>();
  const fix: Y.XmlElement[] = [];
  for (const el of chartElements(live)) {
    const id = String(el.getAttribute('chart') ?? '');
    if (!CHART_ID.test(id) || seen.has(id)) fix.push(el);
    else seen.add(id);
  }
  if (!fix.length) return;
  live.doc.transact(() => {
    for (const el of fix) el.setAttribute('chart', newChartId());
  }, live.system);
}

/** The pictures of the doc's charts in docs/<doc>/assets/, written when they differ; pictures of charts that are gone go. */
export async function syncCharts(doc: { live: LiveDoc; dir: string }): Promise<void> {
  const assets = `${doc.dir}${sep}assets`;
  const want = new Map<string, string>();
  for (const el of chartElements(doc.live)) {
    const id = String(el.getAttribute('chart') ?? '');
    if (!CHART_ID.test(id) || want.has(id)) continue;
    try {
      want.set(id, chartSvg(jsonOf(el)));
    } catch {
      // a chart the schema can't read (mid-sync): next write
    }
  }
  if (want.size) await Deno.mkdir(assets, { recursive: true });
  for (const [id, svg] of want) {
    const path = `${assets}${sep}${chartSrc(id).slice('assets/'.length)}`;
    let now: string | null = null;
    try {
      now = await Deno.readTextFile(path);
    } catch { /* new */ }
    if (now !== svg) await Deno.writeTextFile(path, svg);
  }
  try {
    for await (const e of Deno.readDir(assets)) {
      const m = /^(.+)\.chart\.svg$/.exec(e.name);
      if (e.isFile && m && !want.has(m[1])) await Deno.remove(`${assets}${sep}${e.name}`).catch(() => {});
    }
  } catch { /* no assets folder */ }
}
