// End-to-end updater test: runs the real 0.1.0 AppImage against a local feed serving a real 0.1.1 build.
// Usage: OLD=<0.1.0 AppImage> FEED=<dir with 0.1.1 build> SCRATCH=<tmp dir> node test/update-e2e.mjs
// Both builds must use COZYBROWSIN_UPDATE_URL=http://127.0.0.1:45901. Set USE_FUSE=1 to mount instead of extracting.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const { OLD, FEED, SCRATCH, USE_FUSE } = process.env;
const DISPLAY = ':341';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = f => crypto.createHash('sha512').update(fs.readFileSync(f)).digest('base64');
const key = k => execFileSync('xdotool', ['key', k], { env: { ...process.env, DISPLAY } });
const shot = name => { try { execFileSync('import', ['-window', 'root', `${SCRATCH}/${name}.png`], { env: { ...process.env, DISPLAY } }); } catch {} };

const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1400x900x24'], { stdio: 'ignore' });
await sleep(500);
const wm = spawn('openbox', [], { env: { ...process.env, DISPLAY }, stdio: 'ignore' });
await sleep(500);

let served = FEED;
let hits = [];
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(served, name);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-length': fs.statSync(file).size });
  const stream = fs.createReadStream(file);
  stream.on('end', () => hits.push({ name, finished: true }));
  hits.push({ name, finished: false });
  stream.pipe(res);
});
await new Promise(r => server.listen(45901, '127.0.0.1', r));

const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await sleep(200); } return false; };
const finished = re => () => hits.some(h => h.finished && re.test(h.name));

// Relaunched copies start in their own session, so find everything by where its executable lives.
function killAllUnder(dir) {
  for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
    try { if (fs.readlinkSync(`/proc/${pid}/exe`).startsWith(dir)) process.kill(+pid, 'SIGKILL'); } catch {}
  }
}

async function scenario(name, feed, steps) {
  served = feed;
  hits = [];
  const home = fs.mkdtempSync(`${SCRATCH}/${name}-`);
  fs.mkdirSync(`${home}/tmp`);
  const oldFile = `${home}/${path.basename(OLD)}`;
  fs.copyFileSync(OLD, oldFile);
  fs.chmodSync(oldFile, 0o755);
  const env = { ...process.env, DISPLAY, WAYLAND_DISPLAY: '', HOME: home, XDG_CONFIG_HOME: `${home}/c`, XDG_CACHE_HOME: `${home}/k`, TMPDIR: `${home}/tmp` };
  if (!USE_FUSE) env.APPIMAGE_EXTRACT_AND_RUN = '1';
  const logFd = fs.openSync(`${home}/out.log`, 'a');
  const before = sha(oldFile);
  spawn(oldFile, [], { env, detached: true, stdio: ['ignore', logFd, logFd] }).unref();
  const result = { name, checkedFeed: await until(finished(/latest-linux\.yml$/), 45000) };
  await steps({ result, oldFile, home, before });
  result.log = fs.readFileSync(`${home}/out.log`, 'utf8').split('\n').filter(l => /update|sha512|error|differential|fallback/i.test(l) && !/dbus|gpu/i.test(l)).slice(-8).map(l => l.slice(0, 200));
  result.filesAfter = fs.readdirSync(home).filter(f => f.endsWith('.AppImage'));
  killAllUnder(home);
  await sleep(1000);
  console.log(JSON.stringify(result, null, 1));
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  return result;
}

const newName = fs.readdirSync(FEED).find(f => f.endsWith('.AppImage'));
const newHash = sha(path.join(FEED, newName));

// Accept the prompt: the file is replaced and the new version starts.
await scenario('restart', FEED, async ({ result, home }) => {
  result.downloaded = await until(finished(/\.AppImage$/), 120000);
  await sleep(8000);
  shot('restart-prompt');
  hits = [];
  key('Return');
  result.relaunchCheckedFeed = await until(finished(/latest-linux\.yml$/), 45000);
  const installed = `${home}/${newName}`;
  result.installedMatchesFeed = fs.existsSync(installed) && sha(installed) === newHash;
  result.oldFileRemoved = !fs.existsSync(`${home}/${path.basename(OLD)}`);
  await sleep(4000);
  result.redownloadedAfterUpdate = hits.some(h => /\.AppImage$/.test(h.name));
  shot('restart-after');
});

// Choose Later, then quit: the update installs on the way out.
await scenario('later', FEED, async ({ result, home }) => {
  result.downloaded = await until(finished(/\.AppImage$/), 120000);
  await sleep(8000);
  key('Escape');
  await sleep(2000);
  key('ctrl+q');
  const installed = `${home}/${newName}`;
  result.installedOnQuit = await until(() => fs.existsSync(installed) && sha(installed) === newHash, 30000);
});

// Valid metadata, one flipped byte in the download: nothing may be installed.
const bad = fs.mkdtempSync(`${SCRATCH}/badfeed-`);
for (const f of fs.readdirSync(FEED)) if (fs.statSync(path.join(FEED, f)).isFile()) fs.copyFileSync(path.join(FEED, f), path.join(bad, f));
const fd = fs.openSync(path.join(bad, newName), 'r+');
const byte = Buffer.alloc(1);
fs.readSync(fd, byte, 0, 1, 5000000);
byte[0] ^= 255;
fs.writeSync(fd, byte, 0, 1, 5000000);
fs.closeSync(fd);
await scenario('tampered', bad, async ({ result, oldFile, home, before }) => {
  result.downloaded = await until(finished(/\.AppImage$/), 120000);
  await sleep(10000);
  shot('tampered');
  result.oldFileUnchanged = sha(oldFile) === before;
  result.newFileAbsent = !fs.existsSync(`${home}/${newName}`);
});
fs.rmSync(bad, { recursive: true, force: true });

server.close();
wm.kill();
xvfb.kill();
process.exit(0);
