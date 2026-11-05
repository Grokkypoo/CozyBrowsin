// Windows with a slim tab strip. Each tab is its own WebContentsView under the strip.
const path = require('node:path');
const { BaseWindow, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const { isEnabled, toggleSite } = require('./adblock');

const STRIP_HEIGHT = 36;
const REOPEN_LIMIT = 25;
// Sandboxed, so this only lets the ad block preload run in iframes. It gives pages no Node access.
const PAGE_PREFS = { sandbox: true, contextIsolation: true, nodeIntegrationInSubFrames: true };

const windows = new Map(); // BaseWindow -> window state
const byStrip = new Map(); // strip webContents -> window state
const byPage = new Map(); // page webContents -> tab
let nextTabId = 1;
let lastFocused = null;

const isWeb = url => /^https?:/i.test(url);
const activeTab = state => state.tabs.find(t => t.id === state.activeId);

function pushState(state) {
  if (state.strip.webContents.isDestroyed()) return;
  const tab = activeTab(state);
  const url = tab?.view.webContents.getURL() ?? '';
  state.strip.webContents.send('strip:state', {
    tabs: state.tabs.map(t => ({ id: t.id, title: t.title, favicon: t.favicon, loading: t.loading, active: t === tab })),
    shield: { available: isWeb(url), on: isEnabled(url), blocked: tab?.blocked ?? 0 },
  });
}

function layout(state) {
  const { width, height } = state.win.getContentBounds();
  const top = state.fullscreen ? 0 : STRIP_HEIGHT;
  state.strip.setVisible(!state.fullscreen);
  state.strip.setBounds({ x: 0, y: 0, width, height: STRIP_HEIGHT });
  for (const t of state.tabs) t.view.setBounds({ x: 0, y: top, width, height: Math.max(height - top, 0) });
}

function activate(state, tab) {
  state.activeId = tab.id;
  for (const t of state.tabs) t.view.setVisible(t === tab);
  tab.view.webContents.focus();
  state.win.setTitle(tab.title);
  pushState(state);
}

function closeTab(state, tab) {
  const index = state.tabs.indexOf(tab);
  if (index < 0) return;
  const url = tab.view.webContents.isDestroyed() ? '' : tab.view.webContents.getURL();
  if (isWeb(url)) state.closedUrls = [...state.closedUrls, url].slice(-REOPEN_LIMIT);
  state.tabs.splice(index, 1);
  state.win.contentView.removeChildView(tab.view);
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  if (!state.tabs.length) return state.win.close();
  if (state.activeId === tab.id) activate(state, state.tabs[Math.min(index, state.tabs.length - 1)]);
  else pushState(state);
}

// Popups asked for with a size stay real windows, because sign-in flows depend on them.
function setUpPopup(win) {
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => (isWeb(url) || url === 'about:blank' ? { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: PAGE_PREFS } } : { action: 'deny' }));
  win.webContents.on('did-create-window', setUpPopup);
}

function wireTab(state, tab) {
  const wc = tab.view.webContents;
  const refresh = () => { if (tab.id === state.activeId) state.win.setTitle(tab.title); pushState(state); };
  wc.on('page-title-updated', (_e, title) => { tab.title = title; refresh(); });
  wc.on('page-favicon-updated', (_e, icons) => { tab.favicon = icons.find(isWeb) ?? ''; refresh(); });
  wc.on('did-start-loading', () => { tab.loading = true; refresh(); });
  wc.on('did-stop-loading', () => { tab.loading = false; refresh(); });
  wc.on('did-start-navigation', details => {
    if (!details.isMainFrame || details.isSameDocument) return;
    tab.blocked = 0;
    tab.favicon = '';
    refresh();
  });
  wc.on('did-navigate', refresh);
  wc.on('did-navigate-in-page', refresh);
  wc.on('enter-html-full-screen', () => { state.fullscreen = true; state.win.setFullScreen(true); layout(state); });
  wc.on('leave-html-full-screen', () => { state.fullscreen = false; state.win.setFullScreen(false); layout(state); });
  wc.on('destroyed', () => { byPage.delete(wc); closeTab(state, tab); });
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (!isWeb(url) && url !== 'about:blank') return { action: 'deny' };
    if (disposition === 'new-window') return { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: PAGE_PREFS } };
    // Using the new contents, not just the URL, keeps window.opener working.
    return { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: { webPreferences: PAGE_PREFS }, createWindow: options => {
      const created = addTab(state, { webContents: options.webContents, background: disposition === 'background-tab', afterTab: tab });
      return created.view.webContents;
    } };
  });
  wc.on('did-create-window', setUpPopup);
}

function addTab(state, { url, webContents, background = false, afterTab = null }) {
  const view = new WebContentsView(webContents ? { webContents } : { webPreferences: PAGE_PREFS });
  view.setBackgroundColor('#ffffff');
  const tab = { id: nextTabId++, view, title: 'New Tab', favicon: '', loading: !!url, blocked: 0 };
  const at = afterTab ? state.tabs.indexOf(afterTab) + 1 : state.tabs.length;
  state.tabs.splice(at, 0, tab);
  state.win.contentView.addChildView(view);
  byPage.set(view.webContents, tab);
  tab.state = state;
  wireTab(state, tab);
  layout(state);
  if (background) { view.setVisible(false); pushState(state); } else activate(state, tab);
  if (url) view.webContents.loadURL(url);
  return tab;
}

function openWindow(url, home) {
  const win = new BaseWindow({ width: 1280, height: 800, autoHideMenuBar: true, title: 'CozyBrowsin' });
  win.setMenuBarVisibility(false);
  const strip = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(__dirname, 'strip', 'preload.js') } });
  const state = { win, strip, tabs: [], activeId: null, closedUrls: [], fullscreen: false, home };
  windows.set(win, state);
  byStrip.set(strip.webContents, state);
  lastFocused = state;
  win.contentView.addChildView(strip);
  strip.webContents.loadFile(path.join(__dirname, 'strip', 'strip.html'));
  win.on('resize', () => layout(state));
  win.on('focus', () => {
    lastFocused = state;
    const tab = activeTab(state);
    if (tab && !tab.view.webContents.isDestroyed()) tab.view.webContents.focus();
  });
  win.on('closed', () => {
    windows.delete(win);
    byStrip.delete(strip.webContents);
    if (lastFocused === state) lastFocused = [...windows.values()].at(-1) ?? null;
    for (const t of state.tabs.splice(0)) if (!t.view.webContents.isDestroyed()) t.view.webContents.close();
    if (!strip.webContents.isDestroyed()) strip.webContents.close();
  });
  addTab(state, { url: url ?? home });
  win.show();
  return state;
}

function setUpStripMessages() {
  const on = (channel, fn) => ipcMain.on(channel, (event, ...args) => {
    const state = byStrip.get(event.sender);
    if (state) fn(state, ...args);
  });
  const find = (state, id) => state.tabs.find(t => t.id === id);
  on('strip:ready', pushState);
  on('strip:activate', (state, id) => { const tab = find(state, id); if (tab) activate(state, tab); });
  on('strip:close', (state, id) => { const tab = find(state, id); if (tab) closeTab(state, tab); });
  on('strip:new', state => addTab(state, { url: state.home }));
  on('strip:shield', state => {
    const wc = activeTab(state)?.view.webContents;
    if (!wc || !isWeb(wc.getURL())) return;
    toggleSite(wc.getURL());
    pushState(state);
    wc.reloadIgnoringCache();
  });
}

function countBlocked(wc) {
  const tab = wc && byPage.get(wc);
  if (!tab) return;
  tab.blocked += 1;
  if (tab.state.activeId !== tab.id) return;
  // Pages can block hundreds of requests at once, so don't redraw for each one.
  tab.state.pushTimer ??= setTimeout(() => { tab.state.pushTimer = null; if (windows.has(tab.state.win)) pushState(tab.state); }, 250);
}

const stateOf = win => windows.get(win);
const pageOf = win => {
  const state = stateOf(win);
  if (state) return activeTab(state)?.view.webContents;
  return win.webContents;
};
const ownerWindow = wc => byPage.get(wc)?.state.win ?? BrowserWindow.fromWebContents(wc);

const onState = fn => win => { const state = stateOf(win); if (state) fn(state); };
const newTab = onState(state => addTab(state, { url: state.home }));
const closeActive = win => {
  const state = stateOf(win);
  if (!state) return win.close();
  const tab = activeTab(state);
  if (tab) closeTab(state, tab);
};
const reopenClosed = onState(state => {
  const url = state.closedUrls.at(-1);
  if (!url) return;
  state.closedUrls = state.closedUrls.slice(0, -1);
  addTab(state, { url });
});
const stepTab = delta => onState(state => {
  const i = state.tabs.indexOf(activeTab(state));
  activate(state, state.tabs[(i + delta + state.tabs.length) % state.tabs.length]);
});
// Ctrl+1 to Ctrl+8 pick by position, and Ctrl+9 is always the last tab.
const pickTab = n => onState(state => {
  const tab = n === 9 ? state.tabs.at(-1) : state.tabs[n - 1];
  if (tab) activate(state, tab);
});
const openInLastWindow = (url, home) => {
  const state = lastFocused;
  if (!state) return openWindow(url, home);
  addTab(state, { url: url ?? home });
  state.win.show();
  state.win.focus();
};

module.exports = { openWindow, setUpStripMessages, countBlocked, pageOf, ownerWindow, newTab, closeActive, reopenClosed, stepTab, pickTab, openInLastWindow };
