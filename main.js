// A minimal Chromium browser with tabs and Brave's ad blocker, but no address bar until you ask for one.
// Ctrl+L address, Ctrl+T/W new/close tab, Ctrl+Tab next tab, Alt+Left/Right back/forward, Ctrl+R reload, F12 devtools.
const { app, BrowserWindow, Menu, dialog, session } = require('electron');
const { setUpUpdater, checkForUpdatesNow } = require('./updater');
const { setUpAdblock } = require('./adblock');
const tabs = require('./tabs');

const HOME = 'https://duckduckgo.com/';
const ASK = new Set(['media', 'geolocation', 'notifications', 'display-capture', 'clipboard-read']);
const GO = 'https://cozybrowsin.invalid/go?u=';

// Applies to every page, including popups. Pages see a normal Chrome UA.
app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|cozybrowsin)\/\S+/gi, '');

const urlFromArgs = argv => argv.slice(1).find(a => /^https?:\/\//i.test(a));

function toUrl(text) {
  const t = text.trim();
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[^\s]+\.[^\s]+$/.test(t)) return `https://${t}`;
  return `${HOME}?q=${encodeURIComponent(t)}`;
}

const openWindow = url => tabs.openWindow(url, HOME);

function askForAddress(win) {
  const target = tabs.pageOf(win);
  if (!target) return;
  const box = new BrowserWindow({ parent: win, width: 640, height: 90, resizable: false, minimizable: false, autoHideMenuBar: true, title: 'Go to', webPreferences: { sandbox: true, contextIsolation: true } });
  box.setMenuBarVisibility(false);
  // The page has no bridge to this process. Its one navigation is caught here and never loads.
  box.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(GO)) return;
    e.preventDefault();
    const text = decodeURIComponent(url.slice(GO.length));
    box.close();
    if (text.trim() && !target.isDestroyed()) target.loadURL(toUrl(text));
  });
  const value = JSON.stringify(target.getURL()).replace(/</g, '\\u003c');
  const html = `<!doctype html><title>Go to</title><style>body{margin:12px;font:15px system-ui}input{width:100%;box-sizing:border-box;padding:8px;font:inherit}</style>
<form id=f><input id=a autofocus spellcheck=false></form><script>
a.value=${value};a.select();
f.onsubmit=e=>{e.preventDefault();location.href=${JSON.stringify(GO)}+encodeURIComponent(a.value)};
addEventListener('keydown',e=>{if(e.key==='Escape')close()});
</script>`;
  box.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

const onFocused = fn => (_item, win) => { if (win) fn(win); };
const onPage = fn => onFocused(win => { const page = tabs.pageOf(win); if (page) fn(page); });
const tabNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ label: `Tab ${n}`, accelerator: `CmdOrCtrl+${n}`, click: onFocused(tabs.pickTab(n)) }));
const menu = Menu.buildFromTemplate([{ label: 'Browse', submenu: [
  { label: 'Address', accelerator: 'CmdOrCtrl+L', click: onFocused(askForAddress) },
  { label: 'Back', accelerator: 'Alt+Left', click: onPage(p => p.navigationHistory.goBack()) },
  { label: 'Forward', accelerator: 'Alt+Right', click: onPage(p => p.navigationHistory.goForward()) },
  { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: onPage(p => p.reload()) },
  { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: onFocused(tabs.newTab) },
  { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: onFocused(tabs.closeActive) },
  { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: onFocused(tabs.reopenClosed) },
  { label: 'Next Tab', accelerator: 'CmdOrCtrl+Tab', click: onFocused(tabs.stepTab(1)) },
  { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+Tab', click: onFocused(tabs.stepTab(-1)) },
  ...tabNumbers,
  { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => openWindow() },
  { label: 'Developer Tools', accelerator: 'F12', click: onPage(p => p.toggleDevTools()) },
  { label: 'Check for Updates', click: () => checkForUpdatesNow() },
  { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
] }]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => tabs.openInLastWindow(urlFromArgs(argv), HOME));
  app.whenReady().then(() => {
    Menu.setApplicationMenu(menu);
    // Electron grants everything if there is no handler. Ask once per site per run for sensitive permissions.
    const decisions = new Map();
    const originOf = url => { try { return new URL(url).origin; } catch { return ''; } };
    session.defaultSession.setPermissionRequestHandler(async (wc, permission, cb) => {
      if (!ASK.has(permission)) return cb(true);
      const key = `${originOf(wc.getURL())} ${permission}`;
      if (decisions.has(key)) return cb(decisions.get(key));
      const win = tabs.ownerWindow(wc);
      const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: ['Block', 'Allow'], defaultId: 0, cancelId: 0, message: `${originOf(wc.getURL())} wants: ${permission}` });
      decisions.set(key, response === 1);
      cb(response === 1);
    });
    // Media must pass this check to reach the prompt above. Everything else follows the saved answer.
    session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
      if (permission === 'media' || !ASK.has(permission)) return true;
      return decisions.get(`${originOf(origin)} ${permission}`) === true;
    });
    setUpAdblock(session.defaultSession, tabs.countBlocked);
    tabs.setUpStripMessages();
    openWindow(urlFromArgs(process.argv));
    setUpUpdater();
  });
  app.on('window-all-closed', () => app.quit());
}
