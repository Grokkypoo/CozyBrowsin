// Runs in every page and frame, before the page's own scripts. Pages can't reach anything here.
const { ipcRenderer, webFrame } = require('electron');

const hide = selectors => {
  if (selectors.length) webFrame.insertCSS(selectors.map(s => `${s}{display:none!important}`).join('\n'), { cssOrigin: 'user' });
};

function watchForGenericRules(exceptions) {
  const seenClasses = new Set();
  const seenIds = new Set();
  let classes = [];
  let ids = [];
  let timer = null;
  const collect = el => {
    for (const c of el.classList ?? []) if (!seenClasses.has(c)) { seenClasses.add(c); classes.push(c); }
    if (el.id && !seenIds.has(el.id)) { seenIds.add(el.id); ids.push(el.id); }
  };
  const flush = async () => {
    timer = null;
    if (!classes.length && !ids.length) return;
    const batch = [classes, ids];
    classes = [];
    ids = [];
    hide(await ipcRenderer.invoke('adblock:generic', batch[0], batch[1], exceptions));
  };
  const schedule = () => { timer ??= setTimeout(flush, 100); };
  const scan = root => {
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    collect(root);
    root.querySelectorAll('[class],[id]').forEach(collect);
  };
  new MutationObserver(records => {
    for (const r of records) {
      if (r.type === 'attributes') collect(r.target);
      else r.addedNodes.forEach(scan);
    }
    schedule();
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'id'] });
  addEventListener('DOMContentLoaded', () => { scan(document.documentElement); schedule(); }, { once: true });
}

if (/^https?:/.test(location.href)) {
  const rules = ipcRenderer.sendSync('adblock:cosmetic', location.href);
  if (rules) {
    if (rules.script) webFrame.executeJavaScript(rules.script);
    hide(rules.hide);
    if (!rules.generichide) watchForGenericRules(rules.exceptions);
  }
}
