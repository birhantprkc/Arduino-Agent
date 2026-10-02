/**
 * Tests for the teal -> indigo recoloring of Arduino's themes (src/browser/agent-palette.ts).
 *
 *   yarn test:palette        (from arduino-mcp-extension, after `yarn build`)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { agentColor, toAgentPalette } = require('../../lib/browser/agent-palette');

const THEMES = path.join(__dirname, '..', '..', '..', 'arduino-ide-extension', 'src', 'browser', 'data');

// Minimal OKLCH lightness/hue for assertions (same math as the module).
function oklch(hex) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), H: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

test("Arduino's teal accents move to the icon's indigo at the same lightness", () => {
  for (const teal of ['#008184', '#0ca1a6', '#005c5f', '#7fcbcd', '#00979d']) {
    const before = oklch(teal);
    const after = oklch(agentColor(teal));
    assert.ok(Math.abs(after.H - 277) < 3, `${teal} -> hue ${after.H.toFixed(0)}`);
    assert.ok(Math.abs(after.L - before.L) < 0.01, `${teal} lightness ${before.L.toFixed(3)} -> ${after.L.toFixed(3)}`);
    assert.ok(after.C >= before.C, `${teal} keeps at least its chroma`);
  }
});

test('teal-tinted neutrals stay neutral', () => {
  for (const grey of ['#dae3e3', '#1f272a', '#4e5b61', '#171e21']) {
    const before = oklch(grey);
    const after = oklch(agentColor(grey));
    assert.ok(Math.abs(after.L - before.L) < 0.01, `${grey} lightness kept`);
    assert.ok(after.C < 0.03, `${grey} -> chroma ${after.C.toFixed(3)} stays low`);
  }
});

test('non-teal colors and alpha suffixes are untouched', () => {
  for (const color of ['#ffffff', '#000000', '#bfbfbf', '#ff0000', '#f1c40f', '#df7365', '#d35400']) {
    assert.strictEqual(agentColor(color), color);
  }
  assert.match(agentColor('#dae3e366'), /^#[0-9a-f]{6}66$/);
});

test("both of Arduino's themes convert without leftover teal accents, and the input is not mutated", () => {
  for (const file of ['default.color-theme.json', 'dark.color-theme.json']) {
    const original = JSON.parse(fs.readFileSync(path.join(THEMES, file), 'utf8'));
    const snapshot = JSON.stringify(original);
    const agent = toAgentPalette(original);
    assert.strictEqual(JSON.stringify(original), snapshot, `${file} input mutated`);
    const colors = [
      ...Object.values(agent.colors),
      ...(agent.tokenColors || []).flatMap((t) => Object.values(t.settings || {})),
    ].filter((v) => /^#[0-9a-f]{6}/i.test(v));
    const teal = colors.filter((c) => {
      const { C, H } = oklch(c.slice(0, 7));
      return C >= 0.05 && H >= 160 && H <= 240;
    });
    assert.deepStrictEqual(teal, [], `${file} still has teal accents`);
  }
});
