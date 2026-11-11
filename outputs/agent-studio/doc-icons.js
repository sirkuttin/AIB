'use strict';
/* The docs' icons (16 x 16, stroke = currentColor), shared by the doc page and the entry points (Files rows, tabs, Ctrl+K, chat
   chips): AIBDocIcons.icon(name, className) returns a fresh <svg>; AIBDocIcons.names lists them. Built with createElementNS, so
   no markup is parsed and no inline style is needed (the page's CSP). Paths follow the approved docs design (round 2). */
(function (root) {
  const NS = 'http://www.w3.org/2000/svg';
  // each icon: a list of [tag, attributes]; strokes and fills take currentColor
  const S = {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.3',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  };
  const F = { fill: 'currentColor', stroke: 'none' };
  const ICONS = {
    doc: [
      ['path', { ...S, d: 'M3.5 1.5h6l3 3v10h-9z' }],
      ['path', { ...S, d: 'M5.5 7h5M5.5 9.5h5M5.5 12h3' }],
    ],
    page: [
      ['path', { ...S, d: 'M3.5 1.5h6l3 3v10h-9z' }],
      ['path', { ...S, d: 'M9.5 1.5v3h3' }],
    ],
    comment: [['path', { ...S, d: 'M2 3h12v8H7l-3 2.5V11H2z' }]],
    history: [
      ['circle', { ...S, cx: '8', cy: '8', r: '6' }],
      ['path', { ...S, d: 'M8 4.5V8l2.5 1.5' }],
    ],
    code: [['path', { ...S, 'stroke-width': '1.4', d: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5' }]],
    link: [
      [
        'path',
        {
          ...S,
          'stroke-width': '1.4',
          d: 'M6.8 9.2a3 3 0 0 0 4.2 0l2.2-2.2a3 3 0 0 0-4.2-4.2l-.9.9M9.2 6.8a3 3 0 0 0-4.2 0L2.8 9a3 3 0 0 0 4.2 4.2l.9-.9',
        },
      ],
    ],
    ul: [
      ['circle', { ...F, cx: '3', cy: '4', r: '1.2' }],
      ['circle', { ...F, cx: '3', cy: '8', r: '1.2' }],
      ['circle', { ...F, cx: '3', cy: '12', r: '1.2' }],
      ['path', { ...S, 'stroke-width': '1.4', d: 'M6 4h8M6 8h8M6 12h8' }],
    ],
    ol: [
      ['path', { ...S, 'stroke-width': '1.2', d: 'M1.6 2.6l1-.6v4M1.4 9.6c.3-.6 1.9-.7 1.9.3 0 .8-1.9 1.6-1.9 2.6h2' }],
      ['path', { ...S, 'stroke-width': '1.4', d: 'M6 4h8M6 11.5h8' }],
    ],
    task: [
      ['rect', { ...S, x: '1.5', y: '2', width: '5', height: '5', rx: '1.2' }],
      ['path', { ...S, 'stroke-width': '1.2', d: 'M2.6 4.6l1.1 1.1 1.9-2.1' }],
      ['rect', { ...S, x: '1.5', y: '9', width: '5', height: '5', rx: '1.2' }],
      ['path', { ...S, 'stroke-width': '1.4', d: 'M9 4.5h5.5M9 11.5h5.5' }],
    ],
    table: [
      ['rect', { ...S, x: '1.5', y: '2.5', width: '13', height: '11', rx: '1.5' }],
      ['path', { ...S, 'stroke-width': '1.2', d: 'M1.5 6.2h13M1.5 9.8h13M6 2.5v11' }],
    ],
    image: [
      ['rect', { ...S, x: '1.5', y: '2.5', width: '13', height: '11', rx: '1.5' }],
      ['circle', { ...F, cx: '5.5', cy: '6', r: '1.3' }],
      ['path', { ...S, d: 'M2 12l4-3.5 3 2.5 2-1.5 3.5 3' }],
    ],
    drawing: [
      ['rect', { ...S, x: '1.5', y: '2', width: '5.5', height: '4', rx: '1' }],
      ['rect', { ...S, x: '9', y: '10', width: '5.5', height: '4', rx: '1' }],
      ['path', { ...S, d: 'M4.2 6v4.5c0 1 .6 1.5 1.5 1.5H9' }],
    ],
    quote: [['path', { ...S, 'stroke-width': '1.4', d: 'M3 4v8M6.5 5h7M6.5 8h7M6.5 11h5' }]],
    codeblock: [
      ['rect', { ...S, x: '1.5', y: '2.5', width: '13', height: '11', rx: '1.5' }],
      ['path', { ...S, 'stroke-width': '1.2', d: 'M6 6.5L4.2 8 6 9.5M10 6.5L11.8 8 10 9.5' }],
    ],
    info: [
      ['circle', { ...S, 'stroke-width': '1.4', cx: '8', cy: '8', r: '6.3' }],
      ['path', { ...S, 'stroke-width': '1.6', d: 'M8 7.2v4' }],
      ['circle', { ...F, cx: '8', cy: '4.9', r: '1' }],
    ],
    warning: [
      ['path', { ...S, 'stroke-width': '1.4', d: 'M8 1.8L15 14H1z' }],
      ['path', { ...S, 'stroke-width': '1.6', d: 'M8 6.2v3.6' }],
      ['circle', { ...F, cx: '8', cy: '11.8', r: '1' }],
    ],
    success: [
      ['circle', { ...S, 'stroke-width': '1.4', cx: '8', cy: '8', r: '6.3' }],
      ['path', { ...S, 'stroke-width': '1.6', d: 'M5 8.2l2 2 4-4.2' }],
    ],
    columns: [
      ['rect', { ...S, x: '1.5', y: '2.5', width: '5.5', height: '11', rx: '1.2' }],
      ['rect', { ...S, x: '9', y: '2.5', width: '5.5', height: '11', rx: '1.2' }],
    ],
    toggle: [
      ['path', { ...F, d: 'M2 3.5l3.5 2.5L2 8.5z' }],
      ['path', { ...S, d: 'M7.5 6h7M4 11h10.5M4 13.8h7' }],
    ],
    chart: [
      ['path', { ...S, d: 'M1.5 14.5h13' }],
      ['rect', { ...F, x: '2.5', y: '8', width: '2.6', height: '5', rx: '.6' }],
      ['rect', { ...F, x: '6.7', y: '4.5', width: '2.6', height: '8.5', rx: '.6' }],
      ['rect', { ...F, x: '10.9', y: '2', width: '2.6', height: '11', rx: '.6' }],
    ],
    callout: [
      ['rect', { ...S, x: '1.5', y: '3', width: '13', height: '10', rx: '2' }],
      ['circle', { ...F, cx: '5', cy: '8', r: '1.5' }],
      ['path', { ...S, d: 'M8 7h4.5M8 9.5h3' }],
    ],
    'align-left': [['path', { ...S, 'stroke-width': '1.4', d: 'M2 3.5h12M2 6.5h8M2 9.5h12M2 12.5h8' }]],
    'align-center': [['path', { ...S, 'stroke-width': '1.4', d: 'M2 3.5h12M4 6.5h8M2 9.5h12M4 12.5h8' }]],
    'align-right': [['path', { ...S, 'stroke-width': '1.4', d: 'M2 3.5h12M6 6.5h8M2 9.5h12M6 12.5h8' }]],
    divider: [['path', { ...S, 'stroke-width': '1.5', d: 'M1.5 8h13' }]],
    merge: [
      ['rect', { ...S, x: '1.5', y: '2.5', width: '13', height: '11', rx: '1.5' }],
      ['path', { ...S, 'stroke-width': '1.2', d: 'M1.5 8h13M8 8v5.5' }],
    ],
    full: [['path', { ...S, 'stroke-width': '1.4', d: 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4' }]],
    folder: [['path', { ...S, d: 'M1.5 3.5h5l1.5 1.5h6.5v8.5h-13z' }]],
    plus: [['path', { ...S, 'stroke-width': '1.5', d: 'M8 3v10M3 8h10' }]],
  };
  function icon(name, className) {
    const parts = ICONS[name] || ICONS.doc;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'aib-ico' + (className ? ' ' + className : ''));
    for (const [tag, attrs] of parts) {
      const e = document.createElementNS(NS, tag);
      for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
      svg.appendChild(e);
    }
    return svg;
  }
  const api = Object.freeze({ icon, names: Object.freeze(Object.keys(ICONS)) });
  root.AIBDocIcons = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
