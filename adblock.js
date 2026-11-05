// Ad and tracker blocking with Brave's engine and Brave's default lists (see scripts/fetch-filters.mjs).
// Requests are checked here. Hiding page elements and running scriptlets happens in adblock-preload.js.
const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, net } = require('electron');
const { Engine, FilterSet } = require('adblock-rs');

const UPDATE_DELAY_MS = 60 * 1000;
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
const TRUSTED = 1;
const TYPES = { subFrame: 'subdocument', stylesheet: 'stylesheet', script: 'script', image: 'image', font: 'font', object: 'object', xhr: 'xmlhttprequest', ping: 'ping', cspReport: 'csp_report', media: 'media', webSocket: 'websocket' };

const bundledDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'filters') : path.join(__dirname, 'filters'));
const updatedDir = () => path.join(app.getPath('userData'), 'filters');
const shieldsFile = () => path.join(app.getPath('userData'), 'shields-off.json');
const readManifest = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; } };

let engine;
let offSites = new Set();
let onBlocked = () => {};

function loadEngine() {
  const bundled = readManifest(bundledDir());
  const updated = readManifest(updatedDir());
  const useUpdated = updated && (!bundled || updated.updated > bundled.updated);
  const dir = useUpdated ? updatedDir() : bundledDir();
  const filterSet = new FilterSet(false);
  for (const { file } of (useUpdated ? updated : bundled).lists) {
    filterSet.addFilters(fs.readFileSync(path.join(dir, file), 'utf8'), { permissions: TRUSTED });
  }
  engine = new Engine(filterSet);
  engine.useResources(JSON.parse(fs.readFileSync(path.join(bundledDir(), 'resources.json'), 'utf8')));
}

const hostOf = url => { try { return new URL(url).hostname; } catch { return ''; } };
const isOff = url => offSites.has(hostOf(url));
const isEnabled = url => !isOff(url);


function toggleSite(url) {
  const host = hostOf(url);
  if (!host) return;
  if (!offSites.delete(host)) offSites.add(host);
  fs.writeFileSync(shieldsFile(), JSON.stringify([...offSites]));
}

function checkRequest(details, callback) {
  const type = TYPES[details.resourceType];
  const source = details.webContents?.getURL() || details.referrer;
  if (!type || !source || !/^https?:/.test(source) || isOff(source)) return callback({});
  const result = engine.check(details.url, source, type, details.method.toLowerCase(), true);
  if (result.redirect) { onBlocked(details.webContents); return callback({ redirectURL: result.redirect }); }
  if (!result.should_block) return callback({});
  onBlocked(details.webContents);
  callback({ cancel: true });
}

function cosmeticsFor(event, url) {
  const frame = event.senderFrame;
  const top = frame && frame.parent ? frame.top.url : url;
  if (!/^https?:/.test(url) || isOff(top)) return null;
  const { hide_selectors: hide, exceptions, injected_script: script, generichide } = engine.urlCosmeticResources(url);
  return { hide, exceptions, script, generichide };
}

// Lists only choose what to block. Scriptlet code stays bundled, so a list update can't add new code.
async function updateLists() {
  const current = readManifest(updatedDir());
  const bundled = readManifest(bundledDir());
  const newest = Math.max(current?.updated ?? 0, bundled?.updated ?? 0);
  if (!bundled || Date.now() - newest < UPDATE_EVERY_MS) return;
  const staging = `${updatedDir()}.new`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    for (const { url, file } of bundled.lists) {
      const res = await net.fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      fs.writeFileSync(path.join(staging, file), await res.text());
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({ updated: Date.now(), lists: bundled.lists }));
    fs.rmSync(updatedDir(), { recursive: true, force: true });
    fs.renameSync(staging, updatedDir());
  } catch (err) {
    console.error('Filter list update failed:', err.message);
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function setUpAdblock(session, blockedCallback) {
  onBlocked = blockedCallback;
  try { offSites = new Set(JSON.parse(fs.readFileSync(shieldsFile(), 'utf8'))); } catch {}
  try {
    loadEngine();
  } catch (err) {
    // A browser that won't start is worse than one showing ads, but the failure shouldn't be silent.
    console.error('Ad blocking is off:', err.message);
    ipcMain.on('adblock:cosmetic', e => { e.returnValue = null; });
    return false;
  }
  // Set on the session because tabs opened by rel=noopener links don't inherit a window's preload.
  session.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'adblock-preload.js') });
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, checkRequest);
  ipcMain.on('adblock:cosmetic', (event, url) => { event.returnValue = cosmeticsFor(event, url); });
  ipcMain.handle('adblock:generic', (_e, classes, ids, exceptions) => engine.hiddenClassIdSelectors(classes, ids, exceptions));
  setTimeout(updateLists, UPDATE_DELAY_MS);
  return true;
}

module.exports = { setUpAdblock, isEnabled, toggleSite };
