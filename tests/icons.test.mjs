import test from 'node:test';
import assert from 'node:assert/strict';
import { icon, ICON_NAMES } from '../src/lib/icons.js';

const REQUIRED = [
  'plus', 'settings', 'menu', 'history', 'send', 'stop', 'copy', 'check', 'refresh', 'edit', 'trash',
  'pin', 'image', 'paperclip', 'page', 'globe', 'languages', 'sparkles', 'wand', 'x', 'chevron-down',
  'chevron-right', 'chevron-left', 'download', 'upload', 'external', 'search', 'sun', 'moon', 'monitor',
  'key', 'eye', 'eye-off', 'more', 'user', 'bot', 'alert', 'info', 'bolt', 'brain', 'link', 'play',
  'list', 'sliders', 'shield', 'keyboard',
];

const ELEMENT = /<(path|circle|rect|line|polyline|polygon|ellipse)\b[^<>]*\/>/g;

function inner(svg) {
  return svg.replace(/^<svg\b[^>]*>/, '').replace(/<\/svg>$/, '');
}

test('ICON_NAMES is a non-empty array of unique strings', () => {
  assert.ok(Array.isArray(ICON_NAMES));
  assert.ok(ICON_NAMES.length >= REQUIRED.length);
  assert.equal(new Set(ICON_NAMES).size, ICON_NAMES.length);
  for (const name of ICON_NAMES) assert.equal(typeof name, 'string');
});

test('all icon names from the architecture contract exist', () => {
  for (const name of REQUIRED) assert.ok(ICON_NAMES.includes(name), `missing icon "${name}"`);
});

test('every icon renders a well-formed stroke SVG', () => {
  const fallback = icon('__definitely_unknown__');
  for (const name of ICON_NAMES) {
    const svg = icon(name);
    assert.equal(typeof svg, 'string');
    assert.ok(svg.startsWith('<svg'), `${name} does not start with <svg`);
    assert.ok(svg.endsWith('</svg>'), `${name} does not end with </svg>`);
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.match(svg, /fill="none"/);
    assert.match(svg, /stroke="currentColor"/);
    assert.match(svg, /stroke-width="2"/);
    assert.match(svg, /stroke-linecap="round"/);
    assert.match(svg, /stroke-linejoin="round"/);
    assert.match(svg, /aria-hidden="true"/);
    assert.match(svg, /class="icon"/);
    const body = inner(svg);
    assert.ok(body.length > 0, `${name} has no content`);
    assert.equal(body.replace(ELEMENT, ''), '', `${name} contains unexpected markup`);
    if (name !== 'circle') assert.notEqual(svg, fallback, `${name} renders the fallback`);
  }
});

test('size defaults to 18 and is applied to width and height', () => {
  assert.match(icon('plus'), /width="18" height="18"/);
  assert.match(icon('plus', { size: 24 }), /width="24" height="24"/);
  assert.match(icon('plus', { size: 13.5 }), /width="13.5" height="13.5"/);
  assert.match(icon('plus', { size: '1em' }), /width="1em" height="1em"/);
});

test('invalid sizes fall back to 18', () => {
  assert.match(icon('plus', { size: -4 }), /width="18" height="18"/);
  assert.match(icon('plus', { size: NaN }), /width="18" height="18"/);
  assert.match(icon('plus', { size: '"><script>' }), /width="18" height="18"/);
});

test('cls is appended to the icon class and escaped', () => {
  assert.match(icon('copy', { cls: 'spin big' }), /class="icon spin big"/);
  const evil = icon('copy', { cls: '"><img src=x onerror=alert(1)>' });
  assert.ok(!evil.includes('<img'));
  assert.match(evil, /class="icon &quot;&gt;&lt;img/);
});

test('unknown names fall back to a neutral circle', () => {
  const svg = icon('does-not-exist');
  assert.ok(svg.startsWith('<svg'));
  assert.match(inner(svg), /^<circle\b[^>]*\/>$/);
  assert.equal(icon('another-unknown'), svg);
  assert.equal(icon(undefined), svg);
  assert.equal(icon(null), svg);
  // Prototype keys must not be treated as icons.
  assert.equal(icon('toString'), svg);
  assert.equal(icon('__proto__'), svg);
});

test('aliases render the same markup as their target', () => {
  assert.equal(icon('close'), icon('x'));
  assert.equal(icon('delete'), icon('trash'));
  assert.equal(icon('warning'), icon('alert'));
});
