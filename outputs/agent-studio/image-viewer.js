/* Image lightbox for pictures already on the page (blob: or data:image sources only; nothing is ever fetched).
   open(items, index, opener) with items [{src, name}]; Esc, backdrop click or the close button closes it,
   Left/Right move through the set, Tab stays inside the dialog and focus returns to the opener. */
(function (root) {
  'use strict';
  const SAFE_SOURCE = /^(blob:|data:image\/(png|jpeg|gif|webp);base64,)/i;
  /* Pictures from saved transcripts are served by Studio itself: same origin, one fixed path. */
  const isSafe = (src) => {
    if (typeof src !== 'string') return false;
    if (SAFE_SOURCE.test(src)) return true;
    try {
      const u = new URL(src, root.location && root.location.href);
      return !!root.location && u.origin === root.location.origin && u.pathname === '/api/transcript/image';
    } catch {
      return false;
    }
  };
  let view = null;
  const el = (tag, cls, label) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (label !== undefined) node.textContent = label;
    return node;
  };
  function show() {
    const item = view.items[view.index];
    view.image.src = item.src;
    view.image.alt = item.name || 'Image ' + (view.index + 1);
    view.caption.textContent = (item.name ? item.name + ' · ' : '') + (view.index + 1) + ' of ' + view.items.length;
    view.prev.hidden = view.next.hidden = view.items.length < 2;
  }
  function move(step) {
    if (!view || view.items.length < 2) return;
    view.index = (view.index + step + view.items.length) % view.items.length;
    show();
  }
  function focusable() {
    return [view.close, view.prev, view.next].filter((button) => !button.hidden);
  }
  function onKey(event) {
    if (!view) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      move(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      move(1);
    } else if (event.key === 'Tab') {
      const nodes = focusable(),
        index = nodes.indexOf(document.activeElement);
      event.preventDefault();
      event.stopPropagation();
      nodes[(index + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length].focus();
    }
  }
  function close() {
    if (!view) return;
    const { overlay, opener } = view;
    view = null;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove ? overlay.remove() : overlay.parentNode?.removeChild(overlay);
    if (opener && opener.isConnected !== false && typeof opener.focus === 'function') opener.focus();
  }
  function open(items, index, opener) {
    const list = (Array.isArray(items) ? items : []).filter((item) => item && isSafe(item.src));
    if (!list.length) return false;
    const inherited = view && view.opener;
    if (view) close();
    const overlay = el('div', 'image-viewer'),
      stage = el('div', 'image-viewer-stage'),
      image = el('img', 'image-viewer-image'),
      caption = el('div', 'image-viewer-caption');
    const closeButton = el('button', 'image-viewer-close', '×'),
      prev = el('button', 'image-viewer-nav image-viewer-prev', '‹'),
      next = el('button', 'image-viewer-nav image-viewer-next', '›');
    for (const [button, label] of [
      [closeButton, 'Close image viewer'],
      [prev, 'Previous image'],
      [next, 'Next image'],
    ]) {
      button.type = 'button';
      button.setAttribute('aria-label', label);
    }
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Image viewer');
    stage.append(image);
    overlay.append(stage, caption, prev, next, closeButton);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay || event.target === stage) close();
    });
    closeButton.addEventListener('click', close);
    prev.addEventListener('click', () => move(-1));
    next.addEventListener('click', () => move(1));
    view = {
      overlay,
      stage,
      image,
      caption,
      prev,
      next,
      close: closeButton,
      items: list,
      index: Math.min(Math.max(Number(index) || 0, 0), list.length - 1),
      opener: opener || inherited || document.activeElement,
    };
    document.body.append(overlay);
    document.addEventListener('keydown', onKey, true);
    show();
    closeButton.focus();
    return true;
  }
  /* Make a thumbnail or message picture open the viewer; neighbours in the same strip or message form the set. */
  function makeViewable(image, name) {
    image.classList.add('viewable-image');
    image.tabIndex = 0;
    image.setAttribute('role', 'button');
    image.setAttribute('aria-label', 'View ' + (name || 'image') + ' full size');
    image.dataset.viewerName = name || '';
    const launch = () => {
      const group = image.closest?.('.attachment-list, .bubble, article'),
        nodes = group ? [...group.querySelectorAll('img.viewable-image')] : [image];
      const items = nodes.map((node) => ({ src: node.src, name: node.dataset.viewerName || node.alt || '' }));
      open(items, Math.max(0, nodes.indexOf(image)), image);
    };
    image.addEventListener('click', launch);
    image.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        launch();
      }
    });
  }
  root.ImageViewer = { open, close, makeViewable, isOpen: () => !!view, safeSource: isSafe };
})(window);
