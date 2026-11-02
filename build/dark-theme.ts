import type { Declaration, Plugin, Rule } from 'postcss';

/**
 * The dark theme is derived from the light stylesheet at build time: every colour declaration
 * gets a counterpart under `[data-theme='dark']`. Lightness is remapped in OKLab, so hues stay
 * and elements keep their contrast with the page. Rules marked with a `theme: keep` comment and
 * third-party stylesheets other than the `vendor` ones are left as they are.
 */
export function darkTheme({ vendor }: { vendor?: RegExp } = {}): Plugin {
  return {
    postcssPlugin: 'dark-theme',
    OnceExit(root) {
      const file = root.source?.input.file ?? '';
      if (file.includes('node_modules') && !vendor?.test(file)) return;
      root.walkRules((rule) => {
        if (rule.selector.includes('data-theme') || inKeyframes(rule) || keeps(rule)) return;
        const dark: Declaration[] = [];
        const filled = onAccent(rule);
        const badge = !filled && lightText(rule);
        rule.each((node) => {
          if (node.type !== 'decl') return;
          if (badge && /^background/.test(node.prop)) return; // a coloured badge with light text
          const value = darkValue(node.prop, node.value, filled);
          if (value !== node.value) dark.push(node.clone({ value }));
        });
        if (!dark.length) return;
        rule.after(rule.clone({ selectors: rule.selectors.map(darkSelector), nodes: dark }));
      });
    },
  };
}
darkTheme.postcss = true;

const inKeyframes = (rule: Rule) =>
  rule.parent?.type === 'atrule' && /keyframes$/i.test((rule.parent as { name: string }).name);
const keeps = (rule: Rule) =>
  rule.nodes.some((node) => node.type === 'comment' && node.text.trim() === 'theme: keep');

/** Accent fills turn light in the dark theme, so the light text on them has to turn dark. */
function onAccent(rule: Rule) {
  return rule.nodes.some((node) => {
    if (node.type !== 'decl' || !/^background/.test(node.prop)) return false;
    if (node.value.includes('var(--green)')) return true;
    const colors = node.value.match(COLOR)?.map(parse) ?? [];
    return colors.some((color) => color && color[3] >= 0.5 && isAccent(toOklch(color)));
  });
}
function lightText(rule: Rule) {
  return rule.nodes.some((node) => {
    if (node.type !== 'decl' || node.prop !== 'color') return false;
    const color = node.value.match(COLOR)?.map(parse)[0];
    return !!color && toOklch(color)[0] >= 0.88;
  });
}
const isAccent = ([L, C]: number[]) => L < 0.45 && C > 0.04;

function darkSelector(selector: string) {
  if (selector.startsWith(':root')) return `:root[data-theme='dark']${selector.slice(5)}`;
  if (/^html\b/.test(selector)) return `html[data-theme='dark']${selector.slice(4)}`;
  // `:where` keeps the original specificity, so later and more specific light rules still win.
  return `:where(:root[data-theme='dark']) ${selector}`;
}

type Role = 'text' | 'surface' | 'line' | 'fill';
function roleOf(prop: string): Role | null {
  if (/shadow/.test(prop)) return null;
  if (/^(color|caret-color|-webkit-text-fill-color|text-decoration-color|stroke)$/.test(prop))
    return 'text';
  if (prop === 'fill') return 'fill';
  if (/^(border|outline|column-rule)/.test(prop)) return 'line';
  if (/^(background|accent-color)|^--/.test(prop)) return 'surface';
  return null;
}

const COLOR = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/gi;
export function darkValue(prop: string, value: string, filled = false) {
  const role = roleOf(prop);
  if (!role || value.includes('var(')) return value;
  return value.replace(COLOR, (match) => {
    const color = parse(match);
    if (!color) return match;
    const dark = format(remap(color, role, filled));
    return dark === format(color) ? match : dark;
  });
}

type RGBA = [number, number, number, number];
function parse(text: string): RGBA | null {
  const t = text.toLowerCase();
  if (t === 'white') return [255, 255, 255, 1];
  if (t === 'black') return [0, 0, 0, 1];
  if (t.startsWith('#')) {
    let hex = t.slice(1);
    if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('');
    if (hex.length !== 6 && hex.length !== 8) return null;
    const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), hex.length === 8 ? n(6) / 255 : 1];
  }
  const parts = t.match(/[\d.]+%?/g);
  if (!parts || parts.length < 3) return null;
  const alpha = parts[3] ? parseFloat(parts[3]) / (parts[3].endsWith('%') ? 100 : 1) : 1;
  return [+parts[0], +parts[1], +parts[2], alpha];
}
function format([r, g, b, a]: RGBA) {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v)));
  if (a >= 1) return `#${[r, g, b].map((v) => c(v).toString(16).padStart(2, '0')).join('')}`;
  return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${+a.toFixed(3)})`;
}

/** Page background lightness in the light theme and in the dark one. */
const LIGHT_PAGE = 0.975,
  DARK_PAGE = 0.225;
function remap(rgba: RGBA, role: Role, filled: boolean): RGBA {
  const [L, C, h] = toOklch(rgba);
  const alpha = rgba[3];
  let L2 = L,
    C2 = C;
  if (role === 'fill') role = L >= 0.6 ? 'surface' : 'text';
  if (role === 'text') {
    if (L >= 0.88) {
      if (!filled) return rgba; // white text on a saturated badge
      L2 = 0.22;
      C2 = Math.min(C, 0.03);
    } else L2 = L <= 0.6 ? 0.98 - L * 0.5 : 0.68 - (L - 0.6) * 0.6; // pale text stays subdued
  } else if (alpha < 1 && L <= 0.5) {
    // Faint dark tints (hover, selection) become light ones; denser scrims behind dialogs stay.
    if (alpha >= 0.3) return rgba;
    L2 = 0.97;
    C2 = C * 0.5;
  } else if (L >= 0.6) {
    // The more a surface stands out from the page, the lighter it is on the dark page;
    // lines need a little more contrast to stay visible.
    L2 = DARK_PAGE + Math.abs(L - LIGHT_PAGE) * (role === 'line' ? 1.6 : 1.25);
    C2 = C * 0.8;
  } else if (isAccent([L, C])) {
    // Dark accent fills such as primary buttons turn light, like the text of the same colour.
    L2 = 0.97 - L * 0.6;
    C2 = C * 0.9;
  } else if (C <= 0.04) {
    L2 = 0.3 + L * 0.12; // dark neutral panels such as tooltips
  } // bright accents such as red or orange badges keep their colour
  return [...fromOklch(L2, C2, h), alpha];
}

const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const gam = (v: number) =>
  255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);
function toOklch([r, g, b]: RGBA): [number, number, number] {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B),
    m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B),
    s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(a, bb), Math.atan2(bb, a)];
}
function fromOklch(L: number, C: number, h: number): [number, number, number] {
  // Reduce chroma until the colour fits in sRGB.
  for (let c = C; ; c *= 0.9) {
    const a = c * Math.cos(h),
      b = c * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
      m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
      s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const rgb = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    if (rgb.every((v) => v >= -0.0005 && v <= 1.0005) || c < 0.002)
      return rgb.map(gam) as [number, number, number];
  }
}
