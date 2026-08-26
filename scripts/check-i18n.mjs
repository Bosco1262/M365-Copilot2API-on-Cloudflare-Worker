// i18n completeness checker (unified key-based architecture):
//   Every page (index/login/conversation/debug) embeds
//     /*I18N-START*/ window.I18N_DICT={en:{...},"zh-CN":{...}}; /*@I18N-END*/
//   and loads /vendor/i18n.js. All translatable UI text is marked with
//   data-i18n / data-i18n-html / data-i18n-placeholder / data-i18n-title /
//   data-i18n-aria attributes or resolved via t('key') at runtime.
// Checks per page:
//   1. dict parses; en & zh-CN have identical key sets with non-empty strings
//   2. every referenced key (attributes + plain t('key') calls) resolves in
//      both locales
// Global checks:
//   - shared runtime file exists and every page loads it
//   - legacy text-matching engines are fully retired
// Exits non-zero on any violation. Wired into `npm run check`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

let failures = 0;
const fail = (msg) => { console.error('i18n ERROR:', msg); failures++; };

const PAGES = ['assets/index.html', 'assets/login.html', 'assets/conversation.html', 'assets/debug.html'];
const ATTR_RE = /data-i18n(?:-html|-placeholder|-title|-aria)?="([^"]+)"/g;
const TCALL_RE = /\b(?:I18N\.t|t)\('([A-Za-z0-9_.\-]+)'/g;

for (const page of PAGES) {
  const html = read(page);
  const dm = html.match(/\/\*I18N-START\*\/\s*\nwindow\.I18N_DICT=([\s\S]*?);\n\s*\/\*@I18N-END\*\//);
  if (!dm) { fail(`${page}: I18N_DICT block not found`); continue; }
  let D;
  try {
    D = new Function(`return (${dm[1]})`)();
  } catch (e) {
    fail(`${page}: dict does not parse (${e.message})`);
    continue;
  }
  for (const locale of ['en', 'zh-CN']) {
    if (!D[locale] || typeof D[locale] !== 'object') fail(`${page}: missing locale "${locale}"`);
  }
  if (!D.en || !D['zh-CN']) continue;

  const ek = Object.keys(D.en), zk = Object.keys(D['zh-CN']);
  const missingInZh = ek.filter((k) => typeof D['zh-CN'][k] !== 'string' || D['zh-CN'][k].length === 0);
  const missingInEn = zk.filter((k) => typeof D.en[k] !== 'string' || D.en[k].length === 0);
  for (const k of missingInZh) fail(`${page}: zh-CN missing/empty "${k}"`);
  for (const k of missingInEn) fail(`${page}: en missing/empty "${k}"`);

  const used = new Set();
  for (const m of html.matchAll(ATTR_RE)) used.add(m[1]);
  for (const m of html.matchAll(TCALL_RE)) {
    if (!m[1].endsWith('.')) used.add(m[1]);
  }
  let bad = 0;
  for (const key of used) {
    if (!(key in D.en) || !(key in D['zh-CN'])) {
      fail(`${page}: key "${key}" referenced but not defined in both locales`);
      bad++;
    }
  }
  console.log(`${page}: ${ek.length} keys, ${used.size} used`);
}

// dynamic family coverage on index.html
{
  const html = read('assets/index.html');
  const dm = html.match(/window\.I18N_DICT=([\s\S]*?);\n\/\*@I18N-END\*\//);
  if (dm) {
    const D = new Function(`return (${dm[1]})`)();
    for (const sec of ['dashboard', 'usage', 'accounts', 'apikeys', 'conversations', 'modeltest', 'settings']) {
      for (const locale of ['en', 'zh-CN']) {
        const key = `page.${sec}.title`;
        if (!D[locale] || typeof D[locale][key] !== 'string') fail(`index.html: ${locale} missing "${key}"`);
      }
    }
  }
}

// shared runtime + retirement of legacy engines
if (!fs.existsSync(path.join(root, 'assets', 'vendor', 'i18n.js'))) fail('assets/vendor/i18n.js missing');
for (const page of PAGES) {
  const html = read(page);
  if (!html.includes('<script src="/vendor/i18n.js"></script>')) fail(`${page}: does not load /vendor/i18n.js`);
  for (const legacy of ['LOGIN_T=', 'LEGACY_EN2ZH', 'legacyDynamic', 'applyLoginLang', 'ORIG_TEXT', '/*i18n-mini*/']) {
    if (html.includes(legacy)) fail(`${page}: legacy engine remnant "${legacy}"`);
  }
  // syntax-validate every inline script (catches broken string interpolation)
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  scripts.forEach((s, i) => {
    try {
      new Function(s);
    } catch (e) {
      fail(`${page}: inline script #${i} has a syntax error (${e.message})`);
    }
  });
}

console.log(`i18n check across ${PAGES.length} pages`);
if (failures > 0) {
  console.error(`i18n check FAILED with ${failures} problem(s)`);
  process.exit(1);
}
console.log('i18n check OK');
