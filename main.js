// A plain Chromium window with no browser UI, like Vesktop's "Open Links in App",
// but with its own profile and permission prompts.
// Ctrl+L address, Alt+Left/Right back/forward, Ctrl+R reload, Ctrl+N new window, Ctrl+W close, F12 devtools.
const { app, BrowserWindow, Menu, dialog, session } = require('electron');
const { setUpUpdater, checkForUpdatesNow } = require('./updater');

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

function setUpPage(win) {
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => (/^https?:/i.test(url) || url === 'about:blank' ? { action: 'allow', outlivesOpener: true } : { action: 'deny' }));
  win.webContents.on('did-create-window', setUpPage);
}

function openWindow(url = HOME) {
  const win = new BrowserWindow({ width: 1280, height: 800, autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true } });
  setUpPage(win);
  win.loadURL(url);
  return win;
}

function askForAddress(target) {
  const box = new BrowserWindow({ parent: target, width: 640, height: 90, resizable: false, minimizable: false, autoHideMenuBar: true, title: 'Go to', webPreferences: { sandbox: true, contextIsolation: true } });
  box.setMenuBarVisibility(false);
  // The page has no bridge to this process. Its one navigation is caught here and never loads.
  box.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(GO)) return;
    e.preventDefault();
    const text = decodeURIComponent(url.slice(GO.length));
    box.close();
    if (text.trim() && !target.isDestroyed()) target.loadURL(toUrl(text));
  });
  const value = JSON.stringify(target.webContents.getURL()).replace(/</g, '\\u003c');
  const html = `<!doctype html><title>Go to</title><style>body{margin:12px;font:15px system-ui}input{width:100%;box-sizing:border-box;padding:8px;font:inherit}</style>
<form id=f><input id=a autofocus spellcheck=false></form><script>
a.value=${value};a.select();
f.onsubmit=e=>{e.preventDefault();location.href=${JSON.stringify(GO)}+encodeURIComponent(a.value)};
addEventListener('keydown',e=>{if(e.key==='Escape')close()});
</script>`;
  box.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

const onFocused = fn => (_item, win) => { if (win) fn(win); };
const menu = Menu.buildFromTemplate([{ label: 'Browse', submenu: [
  { label: 'Address', accelerator: 'CmdOrCtrl+L', click: onFocused(askForAddress) },
  { label: 'Back', accelerator: 'Alt+Left', click: onFocused(w => w.webContents.navigationHistory.goBack()) },
  { label: 'Forward', accelerator: 'Alt+Right', click: onFocused(w => w.webContents.navigationHistory.goForward()) },
  { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: onFocused(w => w.webContents.reload()) },
  { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => openWindow() },
  { label: 'Close Window', accelerator: 'CmdOrCtrl+W', click: onFocused(w => w.close()) },
  { label: 'Developer Tools', accelerator: 'F12', click: onFocused(w => w.webContents.toggleDevTools()) },
  { label: 'Check for Updates', click: () => checkForUpdatesNow() },
  { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
] }]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => openWindow(urlFromArgs(argv)));
  app.whenReady().then(() => {
    Menu.setApplicationMenu(menu);
    // Electron grants everything if there is no handler. Ask once per site per run for sensitive permissions.
    const decisions = new Map();
    const originOf = url => { try { return new URL(url).origin; } catch { return ''; } };
    session.defaultSession.setPermissionRequestHandler(async (wc, permission, cb) => {
      if (!ASK.has(permission)) return cb(true);
      const key = `${originOf(wc.getURL())} ${permission}`;
      if (decisions.has(key)) return cb(decisions.get(key));
      const win = BrowserWindow.fromWebContents(wc);
      const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: ['Block', 'Allow'], defaultId: 0, cancelId: 0, message: `${originOf(wc.getURL())} wants: ${permission}` });
      decisions.set(key, response === 1);
      cb(response === 1);
    });
    // Media must pass this check to reach the prompt above. Everything else follows the saved answer.
    session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
      if (permission === 'media' || !ASK.has(permission)) return true;
      return decisions.get(`${originOf(origin)} ${permission}`) === true;
    });
    openWindow(urlFromArgs(process.argv));
    setUpUpdater();
  });
  app.on('window-all-closed', () => app.quit());
}
