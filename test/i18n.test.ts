// Regression tests for the unified key-based i18n architecture
// (mirrors scripts/check-i18n.mjs logic).
// @ts-nocheck -- test-only file; reads raw HTML via node APIs not typed here.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PAGES = ['index.html', 'login.html', 'conversation.html', 'debug.html'];
const assetsDir = path.join(import.meta.dirname ?? '.', '..', 'assets');

function extractDict(page) {
  const m = page.match(/\/\*I18N-START\*\/\s*\n\s*window\.I18N_DICT\s*=\s*([\s\S]*?);\n\s*\/\*@I18N-END\*\//);
  if (!m) throw new Error('I18N_DICT block missing');
  return new Function(`return (${m[1]})`)();
}

const pages = Object.fromEntries(
  PAGES.map((p) => [p, fs.readFileSync(path.join(assetsDir, p), 'utf8')])
);

describe('unified I18N dictionaries', () => {
  for (const [name, html] of Object.entries(pages)) {
    describe(name, () => {
      const dict = extractDict(html);

      it('has exactly en and zh-CN locales', () => {
        expect(Object.keys(dict).sort()).toEqual(['en', 'zh-CN'].sort());
      });

      it('gives every key a non-empty string in both locales', () => {
        for (const locale of ['en', 'zh-CN']) {
          for (const [key, value] of Object.entries(dict[locale])) {
            expect(typeof value, `${locale}:${key}`).toBe('string');
            expect(value.length > 0, `${locale}:${key}`).toBe(true);
          }
        }
      });

      it('en and zh-CN key sets are identical (no orphans / no gaps)', () => {
        expect(Object.keys(dict.en).sort()).toEqual(Object.keys(dict['zh-CN']).sort());
      });

      it('resolves every referenced key (attributes + t calls) in both locales', () => {
        const used = new Set();
        for (const m of html.matchAll(/data-i18n(?:-html|-placeholder|-title|-aria)?="([^"]+)"/g)) {
          used.add(m[1]);
        }
        for (const m of html.matchAll(/\b(?:I18N\.t|t)\('([A-Za-z0-9_.\-]+)'/g)) {
          if (!m[1].endsWith('.')) used.add(m[1]);
        }
        expect(used.size).toBeGreaterThan(0);
        for (const key of used) {
          expect(typeof dict.en[key], `${name} en:${key}`).toBe('string');
          expect(typeof dict['zh-CN'][key], `${name} zh-CN:${key}`).toBe('string');
        }
      });
    });
  }
});

describe('shared runtime contract', () => {
  it('vendor runtime exists', () => {
    expect(fs.existsSync(path.join(assetsDir, 'vendor', 'i18n.js'))).toBe(true);
  });

  it('every page loads /vendor/i18n.js', () => {
    for (const [, html] of Object.entries(pages)) {
      expect(html).toContain('<script src="/vendor/i18n.js"></script>');
    }
  });

  it('legacy text-matching engines are fully retired', () => {
    for (const [, html] of Object.entries(pages)) {
      for (const legacy of ['LOGIN_T=', 'LEGACY_EN2ZH', 'legacyDynamic', 'applyLoginLang', 'ORIG_TEXT', '/*i18n-mini*/']) {
        expect(html.includes(legacy)).toBe(false);
      }
    }
  });

  it('runtime persists locale under m365_locale with zh* detection fallback', () => {
    const runtime = fs.readFileSync(path.join(assetsDir, 'vendor', 'i18n.js'), 'utf8');
    expect(runtime).toContain('"m365_locale"');
    expect(runtime).toContain("indexOf(\"zh\") === 0");
  });
});

describe('index.html page-title family', () => {
  const dict = extractDict(pages['index.html']);
  for (const sec of ['dashboard', 'usage', 'accounts', 'apikeys', 'conversations', 'modeltest', 'settings']) {
    it(`has page.${sec}.title in both locales`, () => {
      expect(typeof dict.en[`page.${sec}.title`]).toBe('string');
      expect(typeof dict['zh-CN'][`page.${sec}.title`]).toBe('string');
    });
  }
});
