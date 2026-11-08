#!/usr/bin/env node
// Zero-dependency build: copies src/ into dist/<target>/, writes the merged manifest.json and
// optionally packs dist/llm-sidebar-<target>-<version>.zip.
//
//   node scripts/build.mjs [--target chrome|firefox|all] [--zip]

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TARGETS = ['chrome', 'firefox'];

const USAGE = [
  'Aufruf: node scripts/build.mjs [--target chrome|firefox|all] [--zip]',
  '',
  '  --target, -t   Zielbrowser (Standard: all)',
  '  --zip          zusätzlich dist/llm-sidebar-<ziel>-<version>.zip erzeugen',
  '  --help, -h     diese Hilfe anzeigen',
].join('\n');

const SKIP_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const CHROME_DESCRIPTION_LIMIT = 132;
// Built-in data consent (data_collection_permissions): Firefox desktop 140+, Android 142+.
const FIREFOX_DATA_CONSENT_MIN = 142;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      if (key === '__proto__') continue;
      out[key] = cloneValue(value[key]);
    }
    return out;
  }
  return value;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item !== null && typeof item === 'object' ? `o:${stableStringify(item)}` : `${typeof item}:${String(item)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function mergeTwo(base, override) {
  if (override === undefined) return cloneValue(base);
  if (Array.isArray(base) && Array.isArray(override)) {
    return dedupe([...base, ...override].map(cloneValue));
  }
  if (isPlainObject(base) && isPlainObject(override)) {
    const out = cloneValue(base);
    for (const key of Object.keys(override)) {
      if (key === '__proto__') continue;
      const value = override[key];
      if (value === undefined) continue;
      out[key] = Object.hasOwn(out, key) ? mergeTwo(out[key], value) : cloneValue(value);
    }
    return out;
  }
  return cloneValue(override);
}

/**
 * Deep-merges plain objects (recursively), concatenates + dedupes arrays, later scalars win.
 * Inputs are never mutated; `undefined` values in overrides are ignored.
 */
export function deepMerge(base, ...overrides) {
  return overrides.reduce((acc, override) => mergeTwo(acc, override), cloneValue(base));
}

/** Chrome/Firefox manifest version: 1–4 dot-separated integers 0–65535 without leading zeros. */
export function isValidManifestVersion(version) {
  if (typeof version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(version)) return false;
  return version.split('.').every((part) => (part === '0' || !part.startsWith('0')) && Number(part) <= 65535);
}

/**
 * Pure: merges a target manifest over the base manifest and sets `version`.
 * Key order: manifest_version, name, version, description, then the rest.
 */
export function buildManifest(base, targetManifest = {}, version = undefined) {
  if (!isPlainObject(base)) throw new TypeError('buildManifest: base muss ein Objekt sein.');
  if (targetManifest !== undefined && !isPlainObject(targetManifest)) {
    throw new TypeError('buildManifest: targetManifest muss ein Objekt sein.');
  }
  const merged = deepMerge(base, targetManifest);
  if (version !== undefined) merged.version = String(version);
  if (!isValidManifestVersion(merged.version)) {
    throw new Error(
      `Ungültige Version „${merged.version ?? ''}“: erlaubt sind 1–4 durch Punkte getrennte Zahlen (0–65535), z. B. 1.2.3.`,
    );
  }
  const ordered = {};
  for (const key of ['manifest_version', 'name', 'version', 'description']) {
    if (Object.hasOwn(merged, key)) ordered[key] = merged[key];
  }
  for (const key of Object.keys(merged)) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = merged[key];
  }
  return ordered;
}

function normalizeRelPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

/**
 * Lists every extension file the manifest references: [{ path, field }] (paths relative to the
 * extension root, forward slashes, unique). Glob patterns (web_accessible_resources) are skipped.
 */
export function listManifestFiles(manifest) {
  const refs = [];
  const add = (value, field) => {
    if (typeof value !== 'string' || !value.trim()) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return; // absolute URLs are not local files
    if (value.includes('*')) return;
    refs.push({ path: normalizeRelPath(value), field });
  };
  const addIcons = (icons, field) => {
    if (typeof icons === 'string') add(icons, field);
    else if (isPlainObject(icons)) for (const [size, file] of Object.entries(icons)) add(file, `${field}.${size}`);
  };
  const m = manifest ?? {};
  addIcons(m.icons, 'icons');
  addIcons(m.action?.default_icon, 'action.default_icon');
  add(m.action?.default_popup, 'action.default_popup');
  add(m.background?.service_worker, 'background.service_worker');
  add(m.background?.page, 'background.page');
  (m.background?.scripts ?? []).forEach((file, i) => add(file, `background.scripts[${i}]`));
  add(m.side_panel?.default_path, 'side_panel.default_path');
  add(m.sidebar_action?.default_panel, 'sidebar_action.default_panel');
  addIcons(m.sidebar_action?.default_icon, 'sidebar_action.default_icon');
  add(m.options_ui?.page, 'options_ui.page');
  add(m.options_page, 'options_page');
  add(m.devtools_page, 'devtools_page');
  (m.content_scripts ?? []).forEach((cs, i) => {
    (cs?.js ?? []).forEach((file, j) => add(file, `content_scripts[${i}].js[${j}]`));
    (cs?.css ?? []).forEach((file, j) => add(file, `content_scripts[${i}].css[${j}]`));
  });
  (m.web_accessible_resources ?? []).forEach((war, i) => {
    const resources = typeof war === 'string' ? [war] : (war?.resources ?? []);
    resources.forEach((file, j) => add(file, `web_accessible_resources[${i}].resources[${j}]`));
  });
  const seen = new Set();
  return refs.filter((ref) => (seen.has(ref.path) ? false : (seen.add(ref.path), true)));
}

// ---------------------------------------------------------------------------
// Manifest translations (_locales)
// ---------------------------------------------------------------------------

/** 'pt-BR' → 'pt_BR' (folder names of the WebExtension _locales directory). */
export function toExtensionLocale(code) {
  return String(code).replace(/-/g, '_');
}

/** 'manifest.cmdTranslatePage' → 'manifest_cmdTranslatePage' (allowed: A-Z a-z 0-9 _ @). */
export function toMessageName(key) {
  return String(key).replace(/[^A-Za-z0-9_@]/g, '_');
}

/**
 * Pure: { code: { key: text } } → { extLocale: messages.json object }. Missing keys fall back to
 * `fallback` (default 'en'), so every locale defines every message the manifest may reference.
 */
export function buildLocaleMessages(catalogs, fallback = 'en') {
  const base = catalogs[fallback] ?? {};
  const out = {};
  for (const [code, catalog] of Object.entries(catalogs)) {
    const messages = {};
    for (const key of Object.keys({ ...base, ...catalog }).sort()) {
      const text = catalog[key] ?? base[key];
      if (typeof text === 'string' && text) messages[toMessageName(key)] = { message: text };
    }
    out[toExtensionLocale(code)] = messages;
  }
  return out;
}

/** Imports src/locales/<code>/manifest.js for every language folder. */
export async function loadManifestCatalogs(rootDir = ROOT) {
  const dir = path.join(rootDir, 'src', 'locales');
  const catalogs = {};
  if (!existsSync(dir)) return catalogs;
  for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, dirent.name, 'manifest.js');
    if (!dirent.isDirectory() || !existsSync(file)) continue;
    const mod = await import(pathToFileURL(file).href);
    catalogs[dirent.name] = mod.default ?? {};
  }
  return catalogs;
}

/** Warnings for translated manifest strings (Chrome Web Store description limit). */
export function localeWarnings(localeMessages, target) {
  const warnings = [];
  if (target !== 'chrome') return warnings;
  for (const [locale, messages] of Object.entries(localeMessages)) {
    const text = messages.manifest_description?.message;
    if (typeof text === 'string' && text.length > CHROME_DESCRIPTION_LIMIT) {
      warnings.push(`_locales/${locale}: description has ${text.length} characters – the Chrome Web Store allows at most ${CHROME_DESCRIPTION_LIMIT}.`);
    }
  }
  return warnings;
}

/** Returns the manifest references that do not exist as files below `dir`. */
export function findMissingFiles(manifest, dir) {
  const root = path.resolve(dir);
  return listManifestFiles(manifest).filter((ref) => {
    const abs = path.resolve(root, ref.path);
    if (abs !== root && !abs.startsWith(root + path.sep)) return true; // escapes the extension root
    try {
      return !statSync(abs).isFile();
    } catch {
      return true;
    }
  });
}

/** Manifest sanity warnings (non-fatal), German. */
export function manifestWarnings(manifest, target) {
  const warnings = [];
  if (target === 'chrome' && typeof manifest.description === 'string' && manifest.description.length > CHROME_DESCRIPTION_LIMIT) {
    warnings.push(
      `description hat ${manifest.description.length} Zeichen – der Chrome Web Store erlaubt höchstens ${CHROME_DESCRIPTION_LIMIT}.`,
    );
  }
  const commandsWithKeys = Object.values(manifest.commands ?? {}).filter((c) => c?.suggested_key);
  if (commandsWithKeys.length > 4) warnings.push('Mehr als 4 Tastenkürzel mit suggested_key – Chrome ignoriert den Rest.');
  const gecko = manifest.browser_specific_settings?.gecko;
  if (target === 'firefox' && gecko?.data_collection_permissions && majorVersion(gecko.strict_min_version) < FIREFOX_DATA_CONSENT_MIN) {
    warnings.push(
      `strict_min_version „${gecko.strict_min_version ?? ''}“: data_collection_permissions braucht Firefox ${FIREFOX_DATA_CONSENT_MIN} (Android) – web-ext lint warnt sonst.`,
    );
  }
  return warnings;
}

function majorVersion(version) {
  const major = Number.parseInt(String(version ?? ''), 10);
  return Number.isFinite(major) ? major : 0;
}

// CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320)
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data, seed = 0) {
  const buf = toBuffer(data);
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (data == null) return Buffer.alloc(0);
  throw new TypeError('Nicht unterstützter Datentyp für ZIP/CRC.');
}

/** Local date → MS-DOS { time, date } (2-second resolution, clamped to 1980–2107). */
export function toDosDateTime(input = new Date()) {
  let d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) d = new Date();
  let year = d.getFullYear();
  if (year < 1980) return { time: 0, date: (0 << 9) | (1 << 5) | 1 };
  if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
  year -= 1980;
  const date = (year << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { time, date };
}

function normalizeZipName(name) {
  const clean = normalizeRelPath(name);
  if (!clean || clean.split('/').some((seg) => seg === '..' || seg === '' || seg === '.')) {
    throw new Error(`Ungültiger Dateiname im ZIP: „${name}“`);
  }
  return clean;
}

/**
 * Builds a ZIP archive in memory.
 * entries: [{ name: 'dir/file.txt', data: Buffer|Uint8Array|string, date?: Date }]
 * Each entry is DEFLATE-compressed (zlib.deflateRawSync) unless that does not shrink it, in which
 * case it is STOREd. No ZIP64 (max 65535 entries / 4 GiB).
 */
export function createZip(entries, { level = 9 } = {}) {
  if (!Array.isArray(entries)) throw new TypeError('createZip: entries muss ein Array sein.');
  if (entries.length > 0xffff) throw new Error('Zu viele Dateien für ein ZIP ohne ZIP64 (max. 65535).');
  const chunks = [];
  const central = [];
  const names = new Set();
  let offset = 0;

  for (const entry of entries) {
    const name = normalizeZipName(entry.name);
    if (names.has(name)) throw new Error(`Doppelter Eintrag im ZIP: ${name}`);
    names.add(name);
    const data = toBuffer(entry.data);
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level });
    const method = deflated.length < data.length ? 8 : 0;
    const body = method === 8 ? deflated : data;
    const { time, date } = toDosDateTime(entry.date ?? new Date());
    const nameBuf = Buffer.from(name, 'utf8');
    const flags = /[^\x20-\x7e]/.test(name) ? 0x0800 : 0; // bit 11: UTF-8 file name

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // made by: MS-DOS, spec 2.0
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt16LE(0, 30); // extra length
    header.writeUInt16LE(0, 32); // comment length
    header.writeUInt16LE(0, 34); // disk number start
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(0, 38); // external attributes
    header.writeUInt32LE(offset, 42);

    chunks.push(local, nameBuf, body);
    central.push(header, nameBuf);
    offset += local.length + nameBuf.length + body.length;
    if (offset > 0xffffffff) throw new Error('ZIP wäre größer als 4 GiB (ZIP64 wird nicht unterstützt).');
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = { targets: [...TARGETS], zip: false, help: false };
  const setTarget = (value) => {
    const v = String(value ?? '').trim().toLowerCase();
    if (v === 'all') options.targets = [...TARGETS];
    else if (TARGETS.includes(v)) options.targets = [v];
    else throw new Error(`Unbekanntes Ziel „${value ?? ''}“ – erlaubt: chrome, firefox, all.`);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--zip') options.zip = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--target' || arg === '-t') {
      if (i + 1 >= argv.length) throw new Error('--target braucht einen Wert (chrome, firefox oder all).');
      setTarget(argv[++i]);
    } else if (arg.startsWith('--target=')) setTarget(arg.slice('--target='.length));
    else throw new Error(`Unbekannte Option „${arg}“.`);
  }
  return options;
}

// ---------------------------------------------------------------------------
// File system steps
// ---------------------------------------------------------------------------

export function shouldSkip(name) {
  const lower = name.toLowerCase();
  return name.startsWith('.') || lower.endsWith('.map') || lower.endsWith('~') || SKIP_NAMES.has(lower);
}

function readJson(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Datei nicht lesbar: ${file} (${err.code ?? err.message})`);
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`Ungültiges JSON in ${file}: ${err.message}`);
  }
}

export function readPackageVersion(rootDir = ROOT) {
  const pkg = readJson(path.join(rootDir, 'package.json'));
  if (!pkg.version) throw new Error('package.json enthält keine "version".');
  return String(pkg.version);
}

/** Reads manifests/base.json + manifests/<target>.json and the package.json version. */
export function loadManifest(target, { rootDir = ROOT, version } = {}) {
  if (!TARGETS.includes(target)) throw new Error(`Unbekanntes Ziel „${target}“.`);
  const base = readJson(path.join(rootDir, 'manifests', 'base.json'));
  const override = readJson(path.join(rootDir, 'manifests', `${target}.json`));
  return buildManifest(base, override, version ?? readPackageVersion(rootDir));
}

async function copyTree(srcDir, destDir, rel = '') {
  const copied = [];
  await fs.mkdir(destDir, { recursive: true });
  const dirents = await fs.readdir(srcDir, { withFileTypes: true });
  for (const dirent of dirents) {
    if (shouldSkip(dirent.name)) continue;
    const from = path.join(srcDir, dirent.name);
    const to = path.join(destDir, dirent.name);
    const relPath = rel ? `${rel}/${dirent.name}` : dirent.name;
    let isDir = dirent.isDirectory();
    let isFile = dirent.isFile();
    if (dirent.isSymbolicLink()) {
      const st = await fs.stat(from).catch(() => null);
      isDir = Boolean(st?.isDirectory());
      isFile = Boolean(st?.isFile());
    }
    if (isDir) copied.push(...(await copyTree(from, to, relPath)));
    else if (isFile) {
      await fs.copyFile(from, to);
      copied.push(relPath);
    }
  }
  return copied;
}

async function listFiles(dir, rel = '') {
  const out = [];
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    const abs = path.join(dir, dirent.name);
    const relPath = rel ? `${rel}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) out.push(...(await listFiles(abs, relPath)));
    else if (dirent.isFile()) out.push(relPath);
  }
  return out;
}

async function zipDirectory(dir, zipPath) {
  const files = (await listFiles(dir)).sort((a, b) => {
    if (a === 'manifest.json') return -1;
    if (b === 'manifest.json') return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const entries = [];
  for (const rel of files) {
    const abs = path.join(dir, ...rel.split('/'));
    const [data, st] = await Promise.all([fs.readFile(abs), fs.stat(abs)]);
    entries.push({ name: rel, data, date: st.mtime });
  }
  const zip = createZip(entries);
  await fs.rm(zipPath, { force: true });
  await fs.writeFile(zipPath, zip);
  return { path: zipPath, bytes: zip.length, entries: entries.length };
}

function assertInside(parent, child) {
  const rel = path.relative(parent, child);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Sicherheitsabbruch: ${child} liegt nicht in ${parent}.`);
  }
}

/**
 * Builds the given targets. Returns { results: [{ target, outDir, files, bytes, zip?, warnings }],
 * errors: [{ target, message }] } – it does not throw for per-target failures.
 */
export async function build({ targets = TARGETS, zip = false, rootDir = ROOT } = {}) {
  const srcDir = path.join(rootDir, 'src');
  const distDir = path.join(rootDir, 'dist');
  if (!existsSync(srcDir)) throw new Error(`Quellordner fehlt: ${srcDir}`);
  const version = readPackageVersion(rootDir);
  const localeMessages = buildLocaleMessages(await loadManifestCatalogs(rootDir));
  const results = [];
  const errors = [];

  for (const target of targets) {
    const outDir = path.join(distDir, target);
    try {
      assertInside(rootDir, outDir);
      const manifest = loadManifest(target, { rootDir, version });
      await fs.rm(outDir, { recursive: true, force: true });
      await copyTree(srcDir, outDir);
      await fs.writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      for (const [locale, messages] of Object.entries(localeMessages)) {
        const localeDir = path.join(outDir, '_locales', locale);
        await fs.mkdir(localeDir, { recursive: true });
        await fs.writeFile(path.join(localeDir, 'messages.json'), `${JSON.stringify(messages, null, 2)}\n`, 'utf8');
      }

      const missing = findMissingFiles(manifest, outDir);
      if (missing.length) {
        await fs.rm(outDir, { recursive: true, force: true });
        const list = missing.map((m) => `  - ${m.path}  (${m.field})`).join('\n');
        throw new Error(`Im Manifest referenzierte Dateien fehlen in src/:\n${list}`);
      }

      const files = await listFiles(outDir);
      let bytes = 0;
      for (const rel of files) bytes += statSync(path.join(outDir, ...rel.split('/'))).size;
      const result = { target, outDir, files: files.length, bytes, warnings: [...manifestWarnings(manifest, target), ...localeWarnings(localeMessages, target)] };
      if (zip) {
        const zipPath = path.join(distDir, `llm-sidebar-${target}-${version}.zip`);
        result.zip = await zipDirectory(outDir, zipPath);
      }
      results.push(result);
    } catch (err) {
      errors.push({ target, message: err.message });
    }
  }
  return { version, results, errors };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(n / 1024 / 1024).toFixed(2).replace('.', ',')} MB`;
}

function isMainModule(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  if (metaUrl === pathToFileURL(path.resolve(entry)).href) return true;
  try {
    const a = realpathSync(fileURLToPath(metaUrl));
    const b = realpathSync(path.resolve(entry));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Fehler: ${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  let outcome;
  try {
    outcome = await build(options);
  } catch (err) {
    console.error(`Build fehlgeschlagen: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const { version, results, errors } = outcome;
  console.log(`LLM Sidebar ${version} – Build\n`);
  for (const r of results) {
    console.log(`OK  ${r.target.padEnd(8)} ${r.outDir}  (${r.files} Dateien, ${formatBytes(r.bytes)})`);
    if (r.zip) console.log(`    ZIP      ${r.zip.path}  (${formatBytes(r.zip.bytes)})`);
    for (const w of r.warnings) console.log(`    Hinweis: ${w}`);
  }
  for (const e of errors) {
    console.error(`FEHLER ${e.target}: ${e.message}`);
  }

  const built = new Set(results.map((r) => r.target));
  if (built.size) {
    console.log('\nSo lädst du die Erweiterung:');
    if (built.has('chrome')) {
      const dir = results.find((r) => r.target === 'chrome').outDir;
      console.log(`  Chrome:  chrome://extensions öffnen → „Entwicklermodus“ einschalten → „Entpackte Erweiterung laden“ → Ordner ${dir} wählen`);
    }
    if (built.has('firefox')) {
      const dir = results.find((r) => r.target === 'firefox').outDir;
      console.log(`  Firefox: about:debugging#/runtime/this-firefox öffnen → „Temporäres Add-on laden …“ → ${path.join(dir, 'manifest.json')} wählen`);
    }
  }
  if (errors.length) {
    console.error(`\n${errors.length} von ${errors.length + results.length} Build(s) fehlgeschlagen.`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`Unerwarteter Fehler: ${err?.stack ?? err}`);
    process.exitCode = 1;
  });
}
