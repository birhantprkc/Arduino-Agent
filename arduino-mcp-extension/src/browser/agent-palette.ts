/**
 * The color math behind agent-theme.ts, free of Theia imports so it can be
 * unit-tested: teal (OKLCH hue 160-240) moves to the icon's indigo at the
 * same lightness; accents gain some chroma, tinted neutrals keep theirs.
 */

const TEAL_HUES: [number, number] = [160, 240];
const ACCENT_HUE = 277; // the icon's #4F46E5
const NEUTRAL_HUE = 275;
const ACCENT_MIN_CHROMA = 0.05;
const ACCENT_CHROMA_GAIN = 1.6;
const MAX_CHROMA = 0.2;

/** A deep copy of a VS Code color theme with every color passed through agentColor(). */
export function toAgentPalette<T>(theme: T): T {
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value) ? agentColor(value) : value;
    }
    if (Array.isArray(value)) {
      return value.map(visit);
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v)]));
    }
    return value;
  };
  return visit(theme) as T;
}

/** Moves a teal color to indigo (see the file header); other colors pass through. */
export function agentColor(hex: string): string {
  const alpha = hex.slice(7);
  const [L, C, H] = rgbToOklch(hexToRgb(hex));
  if (C < 0.003 || H < TEAL_HUES[0] || H > TEAL_HUES[1]) {
    return hex;
  }
  const accent = C >= ACCENT_MIN_CHROMA;
  const hue = accent ? ACCENT_HUE : NEUTRAL_HUE;
  let chroma = accent ? Math.min(C * ACCENT_CHROMA_GAIN, MAX_CHROMA) : C;
  // Reduce chroma until the color fits in sRGB.
  let rgb = oklchToRgb(L, chroma, hue);
  while (!inGamut(rgb) && chroma > 0) {
    chroma = Math.max(0, chroma - 0.005);
    rgb = oklchToRgb(L, chroma, hue);
  }
  return rgbToHex(rgb) + alpha;
}

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as RGB;
}

function rgbToHex(rgb: RGB): string {
  return (
    '#' +
    rgb
      .map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0'))
      .join('')
  );
}

function inGamut(rgb: RGB): boolean {
  return rgb.every((c) => c >= -0.0005 && c <= 1.0005);
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.sign(c) * Math.abs(c) ** (1 / 2.4) - 0.055);

function rgbToOklch(rgb: RGB): [number, number, number] {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const H = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return [L, Math.hypot(a, bb), H];
}

function oklchToRgb(L: number, C: number, H: number): RGB {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(fromLinear) as RGB;
}
