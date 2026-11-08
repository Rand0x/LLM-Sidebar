// Tests for the tooling: manifest merge, ZIP writer, icon renderer/PNG encoder and dev server mocks.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import {
  build,
  buildManifest,
  crc32,
  createZip,
  deepMerge,
  findMissingFiles,
  isValidManifestVersion,
  listManifestFiles,
  loadManifest,
  manifestWarnings,
  parseArgs,
  toDosDateTime,
} from '../scripts/build.mjs';
import { encodePng, ICON_SIZES, renderIcon } from '../scripts/make-icons.mjs';
import { chunkText, injectShim, mockReply, SHIM_TAG, startDevServer } from '../dev/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const readManifest = (name) => JSON.parse(readFileSync(path.join(ROOT, 'manifests', `${name}.json`), 'utf8'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseZip(buf) {
  const eocdOffset = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocdOffset), 0x06054b50, 'EOCD signature');
  const count = buf.readUInt16LE(eocdOffset + 10);
  assert.equal(buf.readUInt16LE(eocdOffset + 8), count);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  assert.equal(cdOffset + cdSize, eocdOffset, 'central directory ends right before EOCD');
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header signature');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, 'local header signature');
    assert.equal(buf.readUInt16LE(localOffset + 8), method, 'local method matches');
    assert.equal(buf.readUInt32LE(localOffset + 14), crc, 'local crc matches');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    entries.push({ name, flags, method, time, date, crc, compSize, size, raw });
  }
  return entries;
}

function decodePng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  let p = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.subarray(p + 4, p + 8).toString('latin1');
    const data = buf.subarray(p + 8, p + 8 + len);
    const crc = buf.readUInt32BE(p + 8 + len);
    assert.equal(crc, crc32(buf.subarray(p + 4, p + 8 + len)), `CRC of ${type}`);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'bit depth');
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  assert.equal(colorType, 6, 'RGBA');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? out[y * stride + x - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else assert.equal(filter, 0, 'known filter type');
      out[y * stride + x] = (v + pred) & 0xff;
    }
  }
  return { width, height, pixels: out };
}

function parseSse(text) {
  return text
    .split(/\n\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
      const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      return { event, data };
    });
}

function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------

describe('deepMerge', () => {
  test('merges objects recursively and lets scalars override', () => {
    const result = deepMerge({ a: { b: 1, c: 2 }, s: 'base', keep: true }, { a: { c: 3, d: 4 }, s: 'override' });
    assert.deepEqual(result, { a: { b: 1, c: 3, d: 4 }, s: 'override', keep: true });
  });

  test('concatenates and dedupes arrays (also objects by value)', () => {
    assert.deepEqual(deepMerge({ p: ['x', 'y'] }, { p: ['y', 'z', 'x'] }), { p: ['x', 'y', 'z'] });
    assert.deepEqual(deepMerge({ n: [1, '1'] }, { n: [1] }), { n: [1, '1'] });
    const merged = deepMerge({ cs: [{ js: ['a.js'], run_at: 'document_idle' }] }, { cs: [{ run_at: 'document_idle', js: ['a.js'] }, { js: ['b.js'] }] });
    assert.deepEqual(merged, { cs: [{ js: ['a.js'], run_at: 'document_idle' }, { js: ['b.js'] }] });
  });

  test('null overrides, undefined is ignored, type mismatch → override wins', () => {
    assert.deepEqual(deepMerge({ a: 1, b: 2, c: [1], d: { x: 1 } }, { a: null, b: undefined, c: 'str', d: [1] }), {
      a: null, b: 2, c: 'str', d: [1],
    });
  });

  test('does not mutate inputs or share references', () => {
    const base = { a: { list: [1] }, o: { deep: { v: 1 } } };
    const over = { a: { list: [2] }, n: { k: [3] } };
    const snapshot = JSON.stringify([base, over]);
    const result = deepMerge(base, over);
    assert.equal(JSON.stringify([base, over]), snapshot);
    result.o.deep.v = 99;
    result.n.k.push(4);
    assert.equal(base.o.deep.v, 1);
    assert.deepEqual(over.n.k, [3]);
  });

  test('supports several overrides and ignores __proto__ keys', () => {
    assert.deepEqual(deepMerge({ a: 1 }, { b: 2 }, { a: 3, c: [1] }, { c: [2] }), { a: 3, b: 2, c: [1, 2] });
    const evil = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');
    const merged = deepMerge({}, evil);
    assert.equal(merged.ok, 1);
    assert.equal({}.polluted, undefined);
    assert.equal(merged.polluted, undefined);
  });
});

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

describe('buildManifest', () => {
  const base = readManifest('base');

  test('chrome: side panel + service worker, version from package.json', () => {
    const m = buildManifest(base, readManifest('chrome'), pkg.version);
    assert.deepEqual(Object.keys(m).slice(0, 4), ['manifest_version', 'name', 'version', 'description']);
    assert.equal(m.manifest_version, 3);
    assert.equal(m.name, 'LLM Sidebar');
    assert.equal(m.version, pkg.version);
    assert.equal(m.side_panel.default_path, 'sidepanel/sidepanel.html');
    assert.equal(m.background.service_worker, 'background/background.js');
    assert.equal(m.background.type, 'module');
    assert.equal(m.background.scripts, undefined);
    assert.equal(m.sidebar_action, undefined);
    assert.equal(m.browser_specific_settings, undefined);
    assert.equal(m.minimum_chrome_version, '116');
    assert.deepEqual(m.permissions, ['storage', 'unlimitedStorage', 'contextMenus', 'scripting', 'activeTab', 'sidePanel']);
    assert.deepEqual(m.host_permissions, ['<all_urls>']);
    assert.deepEqual(Object.keys(m.commands).sort(), ['_execute_action', 'restore-page', 'summarize-page', 'translate-page']);
    assert.equal(m.commands._execute_action.suggested_key.default, 'Alt+Shift+L');
    assert.equal(m.commands['translate-page'].suggested_key.default, 'Alt+Shift+T');
    assert.ok(m.description.length <= 132, 'Chrome Web Store description limit');
    assert.equal(m.options_ui.page, 'options/options.html');
    assert.equal(m.options_ui.open_in_tab, true);
    assert.deepEqual(m.content_scripts, [{
      matches: ['<all_urls>'], js: ['content/content.js'], run_at: 'document_idle', all_frames: true, match_about_blank: true,
    }]);
  });

  test('only two commands have suggested keys; the others are user-assignable', () => {
    for (const target of ['chrome', 'firefox']) {
      const m = buildManifest(base, readManifest(target), pkg.version);
      const withKeys = Object.entries(m.commands).filter(([, c]) => c.suggested_key).map(([name, c]) => [name, c.suggested_key.default]);
      assert.deepEqual(withKeys.sort(), [[target === 'chrome' ? '_execute_action' : '_execute_sidebar_action', 'Alt+Shift+L'], ['translate-page', 'Alt+Shift+T']]);
      for (const name of ['restore-page', 'summarize-page']) {
        assert.equal(m.commands[name].suggested_key, undefined, `${name} has no default key`);
        assert.ok(m.commands[name].description, `${name} has a description`);
      }
      assert.deepEqual(manifestWarnings(m, target), []);
    }
  });

  test('warns when data_collection_permissions meets a too old strict_min_version', () => {
    const firefox = buildManifest(base, readManifest('firefox'), pkg.version);
    const old = deepMerge(firefox, { browser_specific_settings: { gecko: { strict_min_version: '140.0' } } });
    assert.match(manifestWarnings(old, 'firefox').join('\n'), /data_collection_permissions braucht Firefox 142/);
    assert.deepEqual(manifestWarnings(old, 'chrome').filter((w) => /data_collection/.test(w)), []);
  });

  test('firefox: sidebar_action + background scripts + gecko id', () => {
    const m = buildManifest(base, readManifest('firefox'), pkg.version);
    assert.equal(m.version, pkg.version);
    assert.equal(m.description, base.description);
    assert.equal(m.sidebar_action.default_panel, 'sidepanel/sidepanel.html');
    assert.equal(m.sidebar_action.default_title, 'LLM Sidebar');
    assert.equal(m.sidebar_action.open_at_install, false);
    assert.deepEqual(m.background, { scripts: ['background/background.js'], type: 'module' });
    assert.equal(m.side_panel, undefined);
    assert.ok(!m.permissions.includes('sidePanel'));
    assert.equal(m.minimum_chrome_version, undefined);
    assert.equal(m.browser_specific_settings.gecko.id, 'llm-sidebar@local');
    // data_collection_permissions needs Firefox 140 (desktop) / 142 (Android) – web-ext lint warns below 142.
    assert.equal(m.browser_specific_settings.gecko.strict_min_version, '142.0');
    assert.deepEqual(m.browser_specific_settings.gecko.data_collection_permissions, { required: ['websiteContent'] });
    assert.deepEqual(Object.keys(m.commands).sort(), ['_execute_sidebar_action', 'restore-page', 'summarize-page', 'translate-page']);
    assert.equal(m.content_scripts[0].all_frames, true);
    assert.equal(m.content_scripts[0].match_about_blank, true);
    assert.ok(!/upgrade-insecure-requests/.test(m.content_security_policy.extension_pages));
    assert.match(m.content_security_policy.extension_pages, /script-src 'self'/);
  });

  test('loadManifest reads the files and matches buildManifest', () => {
    for (const target of ['chrome', 'firefox']) {
      assert.deepEqual(loadManifest(target), buildManifest(base, readManifest(target), pkg.version));
    }
    assert.throws(() => loadManifest('safari'), /Unbekanntes Ziel/);
  });

  test('rejects invalid versions', () => {
    assert.throws(() => buildManifest(base, {}, '1.0.0-beta.1'), /Ungültige Version/);
    assert.throws(() => buildManifest(base, {}, '01.2'), /Ungültige Version/);
    assert.throws(() => buildManifest(base, {}, '1.2.3.4.5'), /Ungültige Version/);
    assert.ok(isValidManifestVersion('1.0.0'));
    assert.ok(isValidManifestVersion('2.10.0.65535'));
    assert.ok(!isValidManifestVersion('1.65536'));
  });

  test('lists referenced files and the icons exist', () => {
    const chrome = loadManifest('chrome');
    const files = listManifestFiles(chrome).map((r) => r.path);
    for (const expected of [
      'icons/icon-16.png', 'icons/icon-128.png', 'background/background.js', 'sidepanel/sidepanel.html',
      'options/options.html', 'content/content.js',
    ]) {
      assert.ok(files.includes(expected), `${expected} referenced`);
    }
    assert.equal(new Set(files).size, files.length, 'unique');
    const firefoxFiles = listManifestFiles(loadManifest('firefox')).map((r) => r.path);
    assert.ok(firefoxFiles.includes('sidepanel/sidepanel.html'));
    assert.ok(firefoxFiles.includes('background/background.js'));

    const missing = findMissingFiles(chrome, path.join(ROOT, 'src')).map((r) => r.path);
    assert.ok(!missing.some((p) => p.startsWith('icons/')), `icons present (missing: ${missing.join(', ')})`);
    assert.ok(findMissingFiles({ icons: { 16: '../package.json' } }, path.join(ROOT, 'src')).length === 1, 'escaping paths count as missing');
  });
});

// ---------------------------------------------------------------------------
// ZIP writer
// ---------------------------------------------------------------------------

describe('createZip', () => {
  test('crc32 matches the reference value', () => {
    assert.equal(crc32('123456789'), 0xcbf43926);
    assert.equal(crc32(Buffer.alloc(0)), 0);
  });

  test('writes a parseable archive with deflated and stored entries', () => {
    const manifestText = JSON.stringify(loadManifest('chrome'), null, 2).repeat(3);
    const noise = Buffer.alloc(512);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const random = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7919 + 13) % 251));
    const date = new Date(2026, 10, 3, 12, 34, 56);
    const zip = createZip([
      { name: 'manifest.json', data: manifestText, date },
      { name: 'icons/noise.bin', data: random, date },
      { name: 'ordner\\ümlaut.txt', data: 'hallo', date },
      { name: 'leer.txt', data: '', date },
    ]);
    const entries = parseZip(zip);
    assert.equal(entries.length, 4);
    assert.deepEqual(entries.map((e) => e.name), ['manifest.json', 'icons/noise.bin', 'ordner/ümlaut.txt', 'leer.txt']);

    const first = entries[0];
    assert.equal(first.method, 8, 'first entry is deflated');
    const inflated = zlib.inflateRawSync(first.raw);
    assert.equal(inflated.toString('utf8'), manifestText);
    assert.equal(first.size, Buffer.byteLength(manifestText));
    assert.equal(first.crc, crc32(manifestText));
    assert.ok(first.compSize < first.size);

    for (const e of entries) {
      const data = e.method === 8 ? zlib.inflateRawSync(e.raw) : e.raw;
      assert.equal(data.length, e.size, `${e.name} size`);
      assert.equal(crc32(data), e.crc, `${e.name} crc`);
    }
    assert.equal(entries[2].flags & 0x0800, 0x0800, 'UTF-8 flag for non-ASCII names');
    assert.equal(entries[0].flags & 0x0800, 0);
    assert.equal(entries[3].size, 0);

    const dos = toDosDateTime(date);
    assert.equal(first.time, dos.time);
    assert.equal(first.date, dos.date);
    assert.equal((first.date >> 9) + 1980, 2026);
    assert.equal((first.date >> 5) & 0x0f, 11);
    assert.equal(first.date & 0x1f, 3);
    assert.equal(first.time >> 11, 12);
    assert.equal((first.time >> 5) & 0x3f, 34);
    assert.equal((first.time & 0x1f) * 2, 56);
  });

  test('rejects unsafe or duplicate names', () => {
    assert.throws(() => createZip([{ name: '../evil.txt', data: 'x' }]), /Ungültiger Dateiname/);
    assert.throws(() => createZip([{ name: 'a.txt', data: 'x' }, { name: './a.txt', data: 'y' }]), /Doppelter Eintrag/);
    assert.throws(() => createZip([{ name: '', data: 'x' }]), /Ungültiger Dateiname/);
  });

  test('empty archive is valid', () => {
    const zip = createZip([]);
    assert.equal(zip.length, 22);
    assert.deepEqual(parseZip(zip), []);
  });
});

describe('build (temporary project)', () => {
  function makeProject() {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'llm-sidebar-build-'));
    const write = (rel, content) => {
      const abs = path.join(tmp, ...rel.split('/'));
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    };
    write('package.json', JSON.stringify({ name: 'x', version: '2.3.4', type: 'module' }));
    for (const name of ['base', 'chrome', 'firefox']) write(`manifests/${name}.json`, JSON.stringify(readManifest(name)));
    for (const ref of listManifestFiles(loadManifest('chrome')).concat(listManifestFiles(loadManifest('firefox')))) {
      write(`src/${ref.path}`, ref.path.endsWith('.png') ? readFileSync(path.join(ROOT, 'src', ...ref.path.split('/'))) : `// ${ref.path}\n`);
    }
    write('src/lib/app.js', 'export const x = 1;\n');
    write('src/lib/app.js.map', '{}');
    write('src/.DS_Store', 'junk');
    write('src/icons/Thumbs.db', 'junk');
    write('src/.secret/key.txt', 'nope');
    return tmp;
  }

  test('copies src, writes the merged manifest and zips with manifest.json at the root', async () => {
    const tmp = makeProject();
    try {
      const { version, results, errors } = await build({ targets: ['chrome', 'firefox'], zip: true, rootDir: tmp });
      assert.deepEqual(errors, []);
      assert.equal(version, '2.3.4');
      assert.deepEqual(results.map((r) => r.target), ['chrome', 'firefox']);
      for (const target of ['chrome', 'firefox']) {
        const out = path.join(tmp, 'dist', target);
        const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));
        assert.equal(manifest.version, '2.3.4');
        assert.ok(existsSync(path.join(out, 'lib', 'app.js')));
        for (const skipped of ['lib/app.js.map', '.DS_Store', 'icons/Thumbs.db', '.secret/key.txt']) {
          assert.ok(!existsSync(path.join(out, ...skipped.split('/'))), `${skipped} skipped`);
        }
        const zipPath = path.join(tmp, 'dist', `llm-sidebar-${target}-2.3.4.zip`);
        const entries = parseZip(readFileSync(zipPath));
        assert.equal(entries[0].name, 'manifest.json');
        const first = entries[0].method === 8 ? zlib.inflateRawSync(entries[0].raw) : entries[0].raw;
        assert.deepEqual(JSON.parse(first.toString('utf8')), manifest);
        assert.ok(entries.every((e) => !e.name.includes('\\') && !e.name.startsWith('/')));
        assert.ok(entries.some((e) => e.name === 'icons/icon-128.png'));
      }
      assert.ok(JSON.parse(readFileSync(path.join(tmp, 'dist', 'chrome', 'manifest.json'), 'utf8')).side_panel);
      assert.ok(JSON.parse(readFileSync(path.join(tmp, 'dist', 'firefox', 'manifest.json'), 'utf8')).sidebar_action);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('fails with a clear message when referenced files are missing', async () => {
    const tmp = makeProject();
    try {
      rmSync(path.join(tmp, 'src', 'content', 'content.js'));
      rmSync(path.join(tmp, 'src', 'sidepanel', 'sidepanel.html'));
      const { results, errors } = await build({ targets: ['chrome'], rootDir: tmp });
      assert.deepEqual(results, []);
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /content\/content\.js/);
      assert.match(errors[0].message, /sidepanel\/sidepanel\.html\s+\(side_panel\.default_path\)/);
      assert.ok(!existsSync(path.join(tmp, 'dist', 'chrome')), 'broken output removed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('parseArgs', () => {
  test('defaults and options', () => {
    assert.deepEqual(parseArgs([]), { targets: ['chrome', 'firefox'], zip: false, help: false });
    assert.deepEqual(parseArgs(['--target', 'firefox', '--zip']).targets, ['firefox']);
    assert.equal(parseArgs(['--zip']).zip, true);
    assert.deepEqual(parseArgs(['--target=chrome']).targets, ['chrome']);
    assert.deepEqual(parseArgs(['-t', 'all']).targets, ['chrome', 'firefox']);
    assert.throws(() => parseArgs(['--target', 'edge']), /Unbekanntes Ziel/);
    assert.throws(() => parseArgs(['--target']), /braucht einen Wert/);
    assert.throws(() => parseArgs(['--foo']), /Unbekannte Option/);
  });
});

// ---------------------------------------------------------------------------
// Icons / PNG encoder
// ---------------------------------------------------------------------------

describe('icons', () => {
  test('encodePng round-trips arbitrary pixels', () => {
    const w = 13;
    const h = 7;
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < px.length; i++) px[i] = (i * 37 + (i >> 3) * 11) & 0xff;
    const decoded = decodePng(encodePng(w, h, px));
    assert.equal(decoded.width, w);
    assert.equal(decoded.height, h);
    assert.deepEqual([...decoded.pixels], [...px]);
    assert.throws(() => encodePng(2, 2, new Uint8Array(3)), RangeError);
  });

  test('rendered icon has a transparent outside and an opaque body', () => {
    const size = 48;
    const px = renderIcon(size);
    const alpha = (x, y) => px[(y * size + x) * 4 + 3];
    assert.equal(alpha(0, 0), 0, 'corner transparent');
    assert.equal(alpha(size >> 1, size - 3), 255, 'bottom middle opaque');
    const center = ((size >> 1) * size + 4) * 4;
    assert.ok(px[center + 2] > px[center + 1], 'violet/indigo background (blue > green)');
  });

  for (const size of ICON_SIZES) {
    test(`src/icons/icon-${size}.png is a valid ${size}×${size} RGBA PNG`, () => {
      const decoded = decodePng(readFileSync(path.join(ROOT, 'src', 'icons', `icon-${size}.png`)));
      assert.equal(decoded.width, size);
      assert.equal(decoded.height, size);
      const mid = ((size >> 1) * size + (size >> 1)) * 4;
      assert.equal(decoded.pixels[mid + 3], 255, 'center opaque');
    });
  }
});

// ---------------------------------------------------------------------------
// Dev server
// ---------------------------------------------------------------------------

describe('dev server helpers', () => {
  test('injectShim places the tag right after <head>', () => {
    assert.equal(injectShim('<!doctype html><html><head><title>x</title></head></html>'), `<!doctype html><html><head>${SHIM_TAG}<title>x</title></head></html>`);
    assert.equal(injectShim('<HEAD lang="de"><meta>'), `<HEAD lang="de">${SHIM_TAG}<meta>`);
    assert.equal(injectShim('<header>a</header><head></head>'), `<header>a</header><head>${SHIM_TAG}</head>`);
    assert.equal(injectShim('<!DOCTYPE html><html lang="de"><body></body></html>'), `<!DOCTYPE html><html lang="de">${SHIM_TAG}<body></body></html>`);
    assert.equal(injectShim('<!DOCTYPE html><p>x</p>'), `<!DOCTYPE html>${SHIM_TAG}<p>x</p>`);
    assert.equal(injectShim('<p>x</p>'), `${SHIM_TAG}<p>x</p>`);
    const once = injectShim('<head></head>');
    assert.equal(injectShim(once), once, 'idempotent');
  });

  test('mockReply modes', () => {
    assert.equal(mockReply('Antworte nur mit OK.').text, 'OK');
    assert.equal(mockReply('Übersetze:\n[[1]] Hello world\n[[2]]  Second\n').text, '[[1]] [DE] Hello world\n[[2]] [DE] Second');
    const def = mockReply('Erzähl mir   was über Wale', { model: 'mock-chat' });
    assert.ok(def.text.startsWith('**Mock-Antwort** auf: Erzähl mir was über Wale'));
    assert.match(def.text, /\n- .+\n- /);
    assert.match(def.text, /```js\n[\s\S]+\n```/);
    assert.equal(def.reasoning, '');
    assert.ok(mockReply('Denk bitte nach').reasoning.length > 0);
    assert.equal(mockReply('x #fehler429').errorStatus, 429);
    assert.ok(mockReply('a'.repeat(500)).text.includes('…'));
    assert.equal(def.truncated, false);
    const chunks = chunkText('Hällo 👋 Welt, das ist ein Test.');
    assert.equal(chunks.join(''), 'Hällo 👋 Welt, das ist ein Test.');
    assert.ok(chunks.every((c) => Array.from(c).length >= 1 && Array.from(c).length <= 8));
  });

  test('mockReply segment mode only counts markers at a line start', () => {
    const batch = 'Übersetze die folgenden 2 Segmente nach Deutsch. Gib alle Markierungen von [[1]] bis [[2]] genau einmal aus.\n\n[[1]] Hello world\n  [[2]] See [[3]] here\n';
    assert.equal(mockReply(batch).text, '[[1]] [DE] Hello world\n[[2]] [DE] See [[3]] here');
    const single = mockReply('Übersetze das folgende Segment. Gib die Markierung [[1]] genau einmal aus.\n\n[[1]] Only one');
    assert.equal(single.text, '[[1]] [DE] Only one');
    // Markers in the middle of a line only → no segment mode.
    assert.ok(mockReply('Was bedeutet [[1]] in diesem Text?').text.startsWith('**Mock-Antwort**'));
  });

  test('mockReply cuts off with #abschneiden or a small max_tokens', () => {
    const full = mockReply('Erzähl was').text;
    const cut = mockReply('Erzähl was #abschneiden');
    assert.equal(cut.truncated, true);
    assert.ok(cut.text.length < full.length * 0.75 && cut.text.length > 0);
    const limited = mockReply('Erzähl was', { maxTokens: 5 });
    assert.equal(limited.truncated, true);
    assert.ok(Array.from(limited.text).length <= 20);
    assert.equal(mockReply('Antworte nur mit OK', { maxTokens: 5 }).truncated, false);
    assert.equal(mockReply('Erzähl was', { maxTokens: 100000 }).truncated, false);
  });
});

describe('dev server', () => {
  let server;
  let base;

  before(async () => {
    server = await startDevServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${server.port}`;
  });

  after(async () => {
    await server?.close();
  });

  test('redirects / to the harness and serves static files with no-store', async () => {
    const res = await fetch(`${base}/?reset=1`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/dev/harness.html?reset=1');

    const png = await fetch(`${base}/src/icons/icon-16.png`);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(png.headers.get('cache-control'), 'no-store');
    assert.equal(Buffer.from(await png.arrayBuffer())[1], 0x50);

    const js = await fetch(`${base}/src/lib/utils.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /^text\/javascript/);
    await js.text();

    assert.equal((await fetch(`${base}/src/nope.js`)).status, 404);
    assert.equal((await fetch(`${base}/package.json`)).status, 404);
  });

  test('injects the shim into served HTML (separate root)', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'llm-sidebar-dev-'));
    mkdirSync(path.join(tmp, 'src', 'page'), { recursive: true });
    mkdirSync(path.join(tmp, 'dev'), { recursive: true });
    writeFileSync(path.join(tmp, 'src', 'page', 'index.html'), '<!doctype html>\n<html><head><meta charset="utf-8"></head><body>ä</body></html>');
    writeFileSync(path.join(tmp, 'dev', 'plain.html'), '<p>kein head</p>');
    const other = await startDevServer({ port: 0, host: '127.0.0.1', quiet: true, rootDir: tmp });
    try {
      const page = await fetch(`http://127.0.0.1:${other.port}/src/page/index.html`);
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.match(page.headers.get('content-security-policy-report-only'), /script-src 'self'/);
      assert.equal(await page.text(), `<!doctype html>\n<html><head>${SHIM_TAG}<meta charset="utf-8"></head><body>ä</body></html>`);

      const dir = await fetch(`http://127.0.0.1:${other.port}/src/page/`);
      assert.equal(dir.status, 200, 'directory serves index.html');
      await dir.text();

      const plain = await fetch(`http://127.0.0.1:${other.port}/dev/plain.html`);
      assert.equal(plain.headers.get('content-security-policy-report-only'), null);
      assert.equal(await plain.text(), `${SHIM_TAG}<p>kein head</p>`);
    } finally {
      await other.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('blocks directory traversal', async () => {
    for (const p of ['/src/../package.json', '/src/..%2Fpackage.json', '/src/%2e%2e/package.json', '/dev/..%5Cpackage.json', '/src/%2E%2E%2F%2E%2E%2Fpackage.json', '/src/.hidden']) {
      const status = await rawGet(server.port, p);
      assert.ok(status === 403 || status === 404, `${p} → ${status}`);
    }
  });

  test('mock OpenAI: models, preflight, non-stream, segments, errors', async () => {
    const models = await (await fetch(`${base}/mock/v1/models`)).json();
    assert.deepEqual(models.data.map((m) => m.id), ['mock-chat', 'mock-reasoner', 'mock-image']);

    const pre = await fetch(`${base}/mock/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: { Origin: 'chrome-extension://abc', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);

    const post = (body, headers = {}) => fetch(`${base}/mock/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test', ...headers }, body: JSON.stringify(body),
    });
    const ok = await (await post({ model: 'mock-chat', messages: [{ role: 'user', content: 'Antworte nur mit OK' }], stream: false })).json();
    assert.equal(ok.object, 'chat.completion');
    assert.equal(ok.choices[0].message.content, 'OK');
    assert.equal(ok.choices[0].finish_reason, 'stop');

    const seg = await (await post({
      model: 'mock-chat',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: [{ type: 'text', text: '[[1]] Hallo\n[[2]] Welt' }] }],
    })).json();
    assert.equal(seg.choices[0].message.content, '[[1]] [DE] Hallo\n[[2]] [DE] Welt');

    const err = await post({ model: 'mock-chat', messages: [{ role: 'user', content: 'test #fehler429' }] });
    assert.equal(err.status, 429);
    assert.equal((await err.json()).error.type, 'rate_limit_error');

    const bad = await post({ model: 'mock-chat', messages: [] });
    assert.equal(bad.status, 400);
    assert.ok((await bad.json()).error.message);

    const unauthorized = await post({ model: 'mock-chat', messages: [{ role: 'user', content: 'x' }] }, { Authorization: 'Bearer invalid' });
    assert.equal(unauthorized.status, 401);
    await unauthorized.text();

    const invalidJson = await fetch(`${base}/mock/v1/chat/completions`, { method: 'POST', body: '{nope' });
    assert.equal(invalidJson.status, 400);
    await invalidJson.text();

    const unknown = await fetch(`${base}/mock/v1/nothing`);
    assert.equal(unknown.status, 404);
    await unknown.text();
  });

  test('mock OpenAI: streaming with reasoning first and [DONE]', async () => {
    const res = await fetch(`${base}/mock/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock-reasoner', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Denk nach! Antworte nur mit OK' }] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const events = parseSse(await res.text());
    assert.equal(events.at(-1).data, '[DONE]');
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e.data));
    let reasoning = '';
    let text = '';
    let sawTextBeforeReasoningEnded = false;
    for (const c of chunks) {
      const delta = c.choices[0]?.delta ?? {};
      if (delta.reasoning_content) {
        if (text) sawTextBeforeReasoningEnded = true;
        reasoning += delta.reasoning_content;
      }
      if (delta.content) text += delta.content;
    }
    assert.equal(text, 'OK');
    assert.ok(reasoning.length > 20);
    assert.equal(sawTextBeforeReasoningEnded, false, 'reasoning comes first');
    assert.ok(chunks.some((c) => c.choices[0]?.finish_reason === 'stop'));
    assert.ok(chunks.some((c) => c.usage && c.choices.length === 0), 'usage chunk with include_usage');
    assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk'));
  });

  test('mock finish reasons: length / max_tokens and refusals', async () => {
    const openai = async (content, extra = {}) => (await fetch(`${base}/mock/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock-chat', stream: false, messages: [{ role: 'user', content }], ...extra }),
    })).json();
    assert.equal((await openai('Erzähl was #abschneiden')).choices[0].finish_reason, 'length');
    assert.equal((await openai('Erzähl was', { max_completion_tokens: 8 })).choices[0].finish_reason, 'length');
    assert.equal((await openai('Erzähl was #ablehnen')).choices[0].finish_reason, 'content_filter');

    const anthropic = async (content, maxTokens = 1000) => (await fetch(`${base}/mock-anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
    })).json();
    assert.equal((await anthropic('Erzähl was', 8)).stop_reason, 'max_tokens');
    assert.equal((await anthropic('Erzähl was #ablehnen')).stop_reason, 'refusal');
  });

  test('mock OpenAI: survives client disconnect mid-stream', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/mock/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock-chat', stream: true, messages: [{ role: 'user', content: 'Lange Antwort bitte' }] }),
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();
    await reader.read().catch(() => {});
    const again = await fetch(`${base}/mock/v1/models`);
    assert.equal(again.status, 200);
    await again.text();
  });

  test('mock images: returns a 256×256 PNG as b64_json', async () => {
    const res = await fetch(`${base}/mock/v1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock-image', prompt: 'Ein Leuchtturm', n: 1, size: '1024x1024' }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.length, 1);
    const decoded = decodePng(Buffer.from(json.data[0].b64_json, 'base64'));
    assert.equal(decoded.width, 256);
    assert.equal(decoded.height, 256);

    const missing = await fetch(`${base}/mock/v1/images/generations`, { method: 'POST', body: JSON.stringify({ model: 'mock-image' }) });
    assert.equal(missing.status, 400);
    await missing.text();
  });

  test('mock Anthropic: auth, validation, models, non-stream', async () => {
    const noKey = await fetch(`${base}/mock-anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }] }),
    });
    assert.equal(noKey.status, 401);
    const noKeyJson = await noKey.json();
    assert.equal(noKeyJson.type, 'error');
    assert.equal(noKeyJson.error.type, 'authentication_error');

    const headers = { 'Content-Type': 'application/json', 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
    const models = await (await fetch(`${base}/mock-anthropic/v1/models?limit=1000`, { headers })).json();
    assert.ok(models.data.length >= 1);
    assert.equal(models.data[0].type, 'model');
    assert.equal(typeof models.data[0].display_name, 'string');
    assert.equal(typeof models.data[0].capabilities.image_input, 'boolean');
    assert.equal(models.has_more, false);

    const prefill = await fetch(`${base}/mock-anthropic/v1/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hallo' }] }),
    });
    assert.equal(prefill.status, 400);
    assert.equal((await prefill.json()).error.type, 'invalid_request_error');

    const nothink = await fetch(`${base}/mock-anthropic/v1/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'mock-claude-nothink', max_tokens: 100, thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: 'Hi' }] }),
    });
    assert.equal(nothink.status, 400);
    assert.match((await nothink.json()).error.message, /thinking/);

    const json = await (await fetch(`${base}/mock-anthropic/v1/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 100, system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'Denk kurz. Antworte nur mit OK' }] }] }),
    })).json();
    assert.equal(json.type, 'message');
    assert.deepEqual(json.content.map((b) => b.type), ['thinking', 'text']);
    assert.equal(json.content[1].text, 'OK');
    assert.equal(json.stop_reason, 'end_turn');
  });

  test('mock Anthropic: SSE event sequence with thinking + text block', async () => {
    const res = await fetch(`${base}/mock-anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'Bitte denk nach. Antworte nur mit OK' }] }),
    });
    assert.equal(res.status, 200);
    const events = parseSse(await res.text());
    for (const e of events) assert.equal(JSON.parse(e.data).type, e.event, 'event name matches data.type');
    const names = events.map((e) => e.event).filter((n) => n !== 'ping');
    assert.equal(names[0], 'message_start');
    assert.deepEqual(names.slice(-2), ['message_delta', 'message_stop']);
    const starts = events.filter((e) => e.event === 'content_block_start').map((e) => JSON.parse(e.data));
    assert.deepEqual(starts.map((s) => [s.index, s.content_block.type]), [[0, 'thinking'], [1, 'text']]);
    assert.equal(events.filter((e) => e.event === 'content_block_stop').length, 2);
    let thinking = '';
    let text = '';
    let signature = '';
    for (const e of events.filter((x) => x.event === 'content_block_delta')) {
      const { delta } = JSON.parse(e.data);
      if (delta.type === 'thinking_delta') thinking += delta.thinking;
      if (delta.type === 'signature_delta') signature = delta.signature;
      if (delta.type === 'text_delta') text += delta.text;
    }
    assert.ok(thinking.length > 20);
    assert.ok(signature.length > 10);
    assert.equal(text, 'OK');
    const md = JSON.parse(events.find((e) => e.event === 'message_delta').data);
    assert.equal(md.delta.stop_reason, 'end_turn');
    assert.equal(typeof md.usage.output_tokens, 'number');
  });
});
