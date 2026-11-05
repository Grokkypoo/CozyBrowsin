// Drives the packaged app over the DevTools protocol: tabs, popups, ad blocking and the per-site switch.
// Usage: APP=<AppImage or unpacked binary> SCRATCH=<tmp dir> node test/browser-e2e.cjs. Needs network, Xvfb, openbox, xdotool, and playwright-core on NODE_PATH.
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');

const { APP, SCRATCH } = process.env;
const DISPLAY = ':342';
const PORT = 45911;
const CDP = 45912;
// The filter lists skip element hiding on 127.0.0.1, so test pages need real-looking hostnames.
const BASE = `http://cozy-news.example:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const env = { ...process.env, DISPLAY, WAYLAND_DISPLAY: '' };
const key = k => execFileSync('xdotool', ['key', k], { env });
const shot = name => { try { execFileSync('import', ['-window', 'root', `${SCRATCH}/${name}.png`], { env }); } catch {} };

const PAGES = {
  '/ads': `<!doctype html><title>Ad test</title><div class="sponsored-post" id="ad">AD</div><p id="keep" class="article">KEEP</p><iframe id="sub" src="/sub"></iframe>
    <script>window.gone=[];for(const u of ['https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js','https://www.google-analytics.com/analytics.js','https://securepubads.g.doubleclick.net/tag/js/gpt.js']){const s=document.createElement('script');s.src=u;s.onerror=()=>gone.push(u);document.head.append(s)}</script>`,
  '/opener': `<!doctype html><title>Opener</title><a id="blank" target="_blank" href="/child">blank</a><button id="open" onclick="window.open('/child')">open</button><button id="popup" onclick="window.open('/child','p','width=500,height=400')">popup</button>`,
  '/child': `<!doctype html><title>Child</title><script>document.title='Child opener='+!!window.opener;</script>`,
  '/sub': `<!doctype html><title>Sub</title><div class="sponsored-post" id="subad">AD</div>`,
  '/yt': `<!doctype html><title>Yt</title><script>window.parsed=JSON.parse('{"adPlacements":[1],"playerAds":[1],"keep":1}');</script>`,
};

const results = {};
const check = (name, ok, detail) => { results[name] = ok ? 'pass' : `FAIL ${detail ?? ''}`; };

(async () => {
  const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1400x900x24'], { stdio: 'ignore' });
  await sleep(500);
  const wm = spawn('openbox', [], { env, stdio: 'ignore' });
  await sleep(500);
  const server = http.createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(PAGES[q.url] ?? 'x'); }).listen(PORT, '127.0.0.1');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test', '-keyout', `${SCRATCH}/k.pem`, '-out', `${SCRATCH}/c.pem`], { stdio: 'ignore' });
  const tls = https.createServer({ key: fs.readFileSync(`${SCRATCH}/k.pem`), cert: fs.readFileSync(`${SCRATCH}/c.pem`) }, (q, s) => { s.setHeader('content-type', 'text/html'); s.end(PAGES[q.url] ?? 'x'); }).listen(PORT + 2, '127.0.0.1');
  const home = fs.mkdtempSync(`${SCRATCH}/home-`);
  const log = fs.openSync(`${SCRATCH}/app.log`, 'w');
  const app = spawn(APP, [`--remote-debugging-port=${CDP}`, '--ignore-certificate-errors', '--host-resolver-rules=MAP cozy-news.example 127.0.0.1, MAP www.youtube.com 127.0.0.1', `${BASE}/ads`], { env: { ...env, HOME: home, XDG_CONFIG_HOME: `${home}/c`, XDG_CACHE_HOME: `${home}/k`, APPIMAGE_EXTRACT_AND_RUN: '1', TMPDIR: home }, stdio: ['ignore', log, log], detached: true });
  let browser;
  try {
    for (let i = 0; i < 40 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`); } catch { await sleep(500); } }
    if (!browser) throw new Error('could not connect');
    const pages = () => browser.contexts().flatMap(c => c.pages());
    const page = async test => { for (let i = 0; i < 50; i++) { for (const p of pages()) { try { if (await test(p)) return p; } catch {} } await sleep(200); } return null; };
    const byPath = path => page(async p => new URL(p.url()).pathname === path && p.url().startsWith(BASE));
    const strip = await page(async p => p.url().endsWith('strip.html'));
    const tabs = () => strip.$$eval('.tab .title', els => els.map(e => e.textContent));
    const until = async (test, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await test()) return true; } catch {} await sleep(150); } return false; };

    const ads = await byPath('/ads');
    await until(() => ads.evaluate(() => gone.length === 3));
    check('ad, tracker and ad-network scripts blocked', (await ads.evaluate(() => gone.length)) === 3, await ads.evaluate(() => gone.join()));
    await until(() => ads.evaluate(() => getComputedStyle(document.getElementById('ad')).display === 'none'));
    check('ad element hidden', await ads.evaluate(() => getComputedStyle(document.getElementById('ad')).display === 'none'));
    const subFrame = () => ads.frames().find(f => f.url().endsWith('/sub'));
    await until(() => subFrame().evaluate(() => getComputedStyle(document.getElementById('subad')).display === 'none'));
    check('ad hidden inside iframes', await subFrame().evaluate(() => getComputedStyle(document.getElementById('subad')).display === 'none'));
    check('normal content left alone', await ads.evaluate(() => getComputedStyle(document.getElementById('keep')).display !== 'none'));
    await until(async () => /Blocked [1-9]/.test(await strip.textContent('#shield')));
    check('blocked count shown', /Blocked [1-9]/.test(await strip.textContent('#shield')), await strip.textContent('#shield'));
    shot('ads');

    await strip.click('#shield');
    await until(async () => /off/.test(await strip.textContent('#shield')));
    await sleep(1500);
    const adsOff = await byPath('/ads');
    await sleep(2000);
    check('site switch: page no longer filtered', await adsOff.evaluate(() => getComputedStyle(document.getElementById('ad')).display !== 'none'));
    await strip.click('#shield');
    await until(async () => /Blocked/.test(await strip.textContent('#shield')));
    await sleep(1500);
    const adsOn = await byPath('/ads');
    await until(() => adsOn.evaluate(() => gone.length === 3));
    check('site switch: back on', (await adsOn.evaluate(() => gone.length)) === 3);

    await strip.click('#new');
    check('+ button opens a tab', await until(async () => (await tabs()).length === 2), JSON.stringify(await tabs()));
    await sleep(1500);
    key('ctrl+l'); await sleep(1500);
    execFileSync('xdotool', ['type', '--delay', '10', `${BASE}/opener`], { env }); key('Return');
    const opener = await byPath('/opener');
    check('Ctrl+L loads into the current tab', !!opener && (await tabs()).length === 2, JSON.stringify(await tabs()));
    await opener.click('#blank');
    check('target=_blank opens a tab', await until(async () => (await tabs()).length === 3), JSON.stringify(await tabs()));
    await opener.click('#open');
    check('window.open tab keeps window.opener', await until(async () => (await tabs()).includes('Child opener=true')), JSON.stringify(await tabs()));
    await strip.click('.tab:nth-child(4) .close');
    await until(async () => (await tabs()).length === 3);
    const child = await page(async p => p.url().endsWith('/child'));
    check('preload runs in opened tabs', await child.evaluate(() => { const d = document.createElement('div'); d.className = 'sponsored-post'; document.body.append(d); return new Promise(r => setTimeout(() => r(getComputedStyle(d).display === 'none'), 1000)); }));
    await strip.click('.tab:nth-child(2)');
    await sleep(500);
    await opener.click('#popup');
    await sleep(2000);
    check('sized popup stays a separate window', (await tabs()).length === 3 && pages().filter(p => p.url().endsWith('/child')).length === 2, JSON.stringify(await tabs()));
    await (await page(async p => p.url().endsWith('/child') && (await p.evaluate(() => innerWidth)) < 700))?.close();
    await sleep(800);

    // Keys go to whichever tab has focus, so these also prove the menu shortcuts reach a focused page.
    key('ctrl+t');
    check('Ctrl+T', await until(async () => (await tabs()).length === 4), JSON.stringify(await tabs()));
    await sleep(800);
    key('ctrl+w');
    check('Ctrl+W closes one tab', await until(async () => (await tabs()).length === 3), JSON.stringify(await tabs()));
    const active = () => strip.$eval('.tab.active .title', e => e.textContent);
    key('ctrl+1'); await sleep(500);
    check('Ctrl+1', (await active()) === 'Ad test', await active());
    key('ctrl+Tab'); await sleep(500);
    check('Ctrl+Tab moves on', (await active()) !== 'Ad test', await active());
    key('ctrl+9'); await sleep(500);
    check('Ctrl+9 is last tab', (await active()) === (await tabs()).at(-1), await active());
    await strip.dispatchEvent('.tab:nth-child(1)', 'mousedown', { button: 1 });
    check('middle click closes', await until(async () => (await tabs()).length === 2 && !(await tabs()).includes('Ad test')), JSON.stringify(await tabs()));
    key('ctrl+shift+t');
    check('Ctrl+Shift+T reopens', await until(async () => (await tabs()).includes('Ad test')), JSON.stringify(await tabs()));
    shot('tabs');
    await strip.click('#new');
    await sleep(1000);
    key('ctrl+l'); await sleep(1200);
    execFileSync('xdotool', ['type', '--delay', '10', `https://www.youtube.com:${PORT + 2}/yt`], { env }); key('Return');
    const yt = await page(async p => p.url().includes('www.youtube.com'));
    await until(() => yt.evaluate(() => !!window.parsed));
    const parsed = await yt.evaluate(() => JSON.stringify(window.parsed));
    check('YouTube scriptlet runs before page scripts', !/adPlacements|playerAds/.test(parsed) && /keep/.test(parsed), parsed);
    const ua = await page(async p => p.url().endsWith('/ads') || p.url().includes('youtube')).then(p => p.evaluate(() => navigator.userAgent));
    check('user agent hides the app', !/electron|cozybrowsin/i.test(ua), ua);

    for (let i = 0; i < 6 && !app.killed; i++) { key('ctrl+w'); await sleep(500); try { process.kill(app.pid, 0); } catch { break; } }
    await sleep(1500);
    let alive = true;
    try { process.kill(app.pid, 0); } catch { alive = false; }
    check('closing the last tab quits', !alive);
  } catch (err) {
    results.crash = String(err.stack).slice(0, 500);
  }
  console.log(JSON.stringify(results, null, 1));
  console.log(fs.readFileSync(`${SCRATCH}/app.log`, 'utf8').split('\n').filter(l => /uncaught|TypeError|ReferenceError|Ad blocking is off|Error:/i.test(l) && !/dbus|gpu|ERR_/i.test(l)).slice(0, 10).join('\n').slice(0, 1500));
  try { await browser?.close(); } catch {}
  try { process.kill(-app.pid, 'SIGKILL'); } catch {}
  for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
    try { if (fs.readlinkSync(`/proc/${pid}/exe`).startsWith(home)) process.kill(+pid, 'SIGKILL'); } catch {}
  }
  server.close(); tls.close(); wm.kill(); xvfb.kill();
  process.exit(Object.values(results).every(r => r === 'pass') ? 0 : 1);
})();
