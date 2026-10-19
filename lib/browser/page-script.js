// Runs inside each frame via frame.evaluate. Keeps element ids stable across reads
// (WeakMap element→id) so a ref the model saw stays valid until the element is removed.
export function snapshotFrame({ filter = 'interactive', maxDepth = 40, maxNodes = 1500 } = {}) {
  const obu = (window.__obu ||= { ids: new WeakMap(), els: new Map(), next: 1 });
  const idOf = el => {
    let id = obu.ids.get(el);
    if (!id) { id = obu.next++; obu.ids.set(el, id); obu.els.set(id, new WeakRef(el)); }
    return id;
  };
  const interactiveRoles = new Set(['button', 'link', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'clickable']);
  const landmarks = { nav: 'navigation', main: 'main', form: 'form', dialog: 'dialog', table: 'table', header: 'banner', footer: 'contentinfo', aside: 'complementary', ul: 'list', ol: 'list', li: 'listitem', img: 'img', iframe: 'iframe' };
  const inputRoles = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button', range: 'slider', search: 'searchbox', number: 'spinbutton', hidden: null };
  const clip = (s, n = 100) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const roleOf = el => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    const t = el.tagName.toLowerCase();
    if (t === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'input') { const type = (el.getAttribute('type') || 'text').toLowerCase(); return type in inputRoles ? inputRoles[type] : 'textbox'; }
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (t === 'option') return 'option';
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    if (t in landmarks) return landmarks[t];
    const tabbable = el.tabIndex >= 0 && el.hasAttribute('tabindex');
    if (tabbable || el.hasAttribute('onclick')) return 'clickable';
    const style = getComputedStyle(el);
    if (style.cursor === 'pointer' && el.parentElement && getComputedStyle(el.parentElement).cursor !== 'pointer') return 'clickable';
    return null;
  };
  const nameOf = el => {
    const by = el.getAttribute('aria-labelledby');
    const labelled = by && by.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ');
    const t = el.tagName.toLowerCase();
    const formValue = t === 'input' && ['submit', 'button', 'reset'].includes(el.type) ? el.value : '';
    return clip(el.getAttribute('aria-label') || labelled || (el.labels?.[0]?.innerText) || el.getAttribute('alt') || formValue
      || (['input', 'textarea', 'select'].includes(t) ? '' : el.innerText) || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '');
  };
  const attrsOf = (el, role) => {
    const a = {};
    const t = el.tagName.toLowerCase();
    if (role === 'link') a.href = clip(el.getAttribute('href'), 120);
    if (t === 'input' || t === 'textarea') {
      a.type = el.type;
      if (el.type === 'password') a.value = el.value ? '••••' : '';
      else if (['checkbox', 'radio'].includes(el.type)) a.checked = el.checked;
      else if (el.value) a.value = clip(el.value, 120);
      if (el.placeholder) a.placeholder = clip(el.placeholder, 60);
    }
    if (t === 'select') { a.value = clip(el.selectedOptions?.[0]?.text || '', 60); a.options = Array.from(el.options).slice(0, 25).map(o => clip(o.text, 40)); }
    if (el.isContentEditable && el.innerText) a.value = clip(el.innerText, 120);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') a.disabled = true;
    for (const k of ['expanded', 'selected', 'pressed', 'checked']) { const v = el.getAttribute('aria-' + k); if (v != null) a[k] = v; }
    if (role === 'heading') a.level = Number(el.tagName[1]) || Number(el.getAttribute('aria-level')) || undefined;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) a.offscreen = true;
    return a;
  };
  const visible = el => {
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const nodes = [];
  const walk = (el, depth, outDepth) => {
    if (nodes.length >= maxNodes || depth > maxDepth) return;
    const t = el.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'template', 'svg', 'head'].includes(t)) return;
    if (getComputedStyle(el).display === 'none') return;
    const role = roleOf(el);
    const show = visible(el) && role && (filter === 'all' ? true : interactiveRoles.has(role) || role === 'iframe');
    if (show) nodes.push({ d: outDepth, id: idOf(el), role, name: nameOf(el), attrs: attrsOf(el, role) });
    else if (filter === 'all' && visible(el)) {
      const text = clip(Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join(' '), 200);
      if (text) nodes.push({ d: outDepth, role: 'text', name: text, attrs: {} });
    }
    // Leaf controls: their text is already the name.
    if (show && ['button', 'link', 'textbox', 'searchbox', 'combobox', 'heading', 'option'].includes(role)) return;
    const next = show ? outDepth + 1 : outDepth;
    if (el.shadowRoot) for (const c of el.shadowRoot.children) walk(c, depth + 1, next);
    for (const c of el.children) walk(c, depth + 1, next);
  };
  if (document.body) walk(document.body, 0, 0);
  return { nodes, truncated: nodes.length >= maxNodes, url: location.href, title: document.title };
}

export function elementById(id) {
  const el = window.__obu?.els.get(id)?.deref();
  return el && el.isConnected ? el : null;
}
