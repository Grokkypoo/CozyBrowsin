const tabsEl = document.getElementById('tabs');
const shieldEl = document.getElementById('shield');

function renderTab(tab) {
  const el = document.createElement('div');
  el.className = `tab${tab.active ? ' active' : ''}${tab.loading ? ' loading' : ''}`;
  el.title = tab.title;
  el.addEventListener('mousedown', e => {
    if (e.button === 0) tabStrip.activate(tab.id);
    if (e.button === 1) { e.preventDefault(); tabStrip.close(tab.id); }
  });
  if (tab.favicon && !tab.loading) {
    const img = document.createElement('img');
    img.src = tab.favicon;
    img.addEventListener('error', () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'dot' })));
    el.append(img);
  } else {
    el.append(Object.assign(document.createElement('span'), { className: 'dot' }));
  }
  el.append(Object.assign(document.createElement('span'), { className: 'title', textContent: tab.title }));
  const close = Object.assign(document.createElement('button'), { className: 'close', textContent: '×', title: 'Close tab (Ctrl+W)' });
  close.addEventListener('mousedown', e => e.stopPropagation());
  close.addEventListener('click', () => tabStrip.close(tab.id));
  el.append(close);
  return el;
}

tabStrip.onState(({ tabs, shield }) => {
  tabsEl.replaceChildren(...tabs.map(renderTab));
  shieldEl.hidden = !shield.available;
  shieldEl.className = shield.on ? '' : 'off';
  shieldEl.textContent = shield.on ? `Blocked ${shield.blocked}` : 'Blocking off';
  shieldEl.title = shield.on ? 'Turn off blocking on this site' : 'Turn on blocking on this site';
});
document.getElementById('new').addEventListener('click', () => tabStrip.newTab());
shieldEl.addEventListener('click', () => tabStrip.toggleShield());
tabStrip.ready();
