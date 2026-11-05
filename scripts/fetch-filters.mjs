// Downloads Brave's default filter lists and scriptlet resources into filters/ for bundling into the app.
// Brave's catalog decides the lists, so they follow Brave's defaults. Mobile-only lists are left out.
// Brave builds its scriptlets from uBlock Origin's source the same way, so that's pinned to a release here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { uBlockResources } = require('adblock-rs');

const CATALOG = 'https://raw.githubusercontent.com/brave/adblock-resources/master/filter_lists/list_catalog.json';
const BRAVE_RESOURCES = 'https://raw.githubusercontent.com/brave/adblock-resources/master/dist/resources.json';
const UBO_TAG = '1.75.4';
const SKIP_LISTS = new Set(['Brave IOS-Specific Filters', 'Mobile app promo blocker']);
const SKIP_SOURCES = /brave-(android|ios)-specific/;
const OUT = path.resolve(import.meta.dirname, '../filters');

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

const catalog = JSON.parse(await get(CATALOG));
const urls = catalog
  .filter(list => list.default_enabled && !SKIP_LISTS.has(list.title))
  .flatMap(list => list.sources.map(source => source.url))
  .filter(url => !SKIP_SOURCES.test(url));
if (urls.length < 10) throw new Error(`Only ${urls.length} lists in the catalog, which looks wrong`);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const manifest = [];
for (const [i, url] of urls.entries()) {
  const file = `${String(i).padStart(2, '0')}-${path.basename(new URL(url).pathname)}`;
  fs.writeFileSync(path.join(OUT, file), await get(url));
  manifest.push({ url, file });
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ updated: Date.now(), lists: manifest }, null, 1));
console.log(`${manifest.length} lists`);

async function uBlockScriptlets(root) {
  fs.writeFileSync(path.join(root, 'src/js/resources/package.json'), '{"type":"module"}');
  const { builtinScriptlets } = await import(pathToFileURL(path.join(root, 'src/js/resources/scriptlets.js')));
  return builtinScriptlets.map(({ name, aliases = [], fn, dependencies = [], requiresTrust }) => ({
    name,
    aliases,
    kind: { mime: name.endsWith('.fn') ? 'fn/javascript' : 'application/javascript' },
    content: Buffer.from(fn.toString()).toString('base64'),
    dependencies,
    permission: requiresTrust ? 1 : 0,
  }));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ubo-'));
try {
  const res = await fetch(`https://github.com/gorhill/uBlock/archive/refs/tags/${UBO_TAG}.tar.gz`);
  if (!res.ok) throw new Error(`uBlock ${UBO_TAG}: HTTP ${res.status}`);
  fs.writeFileSync(path.join(tmp, 'ubo.tgz'), Buffer.from(await res.arrayBuffer()));
  execFileSync('tar', ['-xzf', 'ubo.tgz', '--strip-components=1'], { cwd: tmp });
  const redirects = uBlockResources(path.join(tmp, 'src/web_accessible_resources'), path.join(tmp, 'src/js/redirect-resources.js'));
  const scriptlets = await uBlockScriptlets(tmp);
  const brave = JSON.parse(await get(BRAVE_RESOURCES));
  // Brave's own copy wins if a name appears twice.
  const byName = new Map([...redirects, ...scriptlets, ...brave].map(r => [r.name, r]));
  const resources = [...byName.values()];
  fs.writeFileSync(path.join(OUT, 'resources.json'), JSON.stringify(resources));
  console.log(`${resources.length} resources: ${redirects.length} redirects, ${scriptlets.length} scriptlets, ${brave.length} from Brave`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
