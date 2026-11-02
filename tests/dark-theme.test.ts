import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { darkTheme, darkValue } from '../build/dark-theme';

const lightness = (hex: string) => parseInt(hex.slice(1, 3), 16);
const dark = (css: string) =>
  postcss([darkTheme()]).process(css, { from: 'web/style.css' }).css.slice(css.length).trim();

describe('derived dark theme', () => {
  it('turns light surfaces dark and dark text light, keeping custom properties and shadows', () => {
    expect(lightness(darkValue('background', '#fff'))).toBeLessThan(0x30);
    expect(lightness(darkValue('border-color', '#e1e5dd'))).toBeLessThan(0x40);
    expect(lightness(darkValue('color', '#26362c'))).toBeGreaterThan(0xa0);
    expect(darkValue('color', 'var(--text)')).toBe('var(--text)');
    expect(darkValue('box-shadow', '0 1px 2px #000')).toBe('0 1px 2px #000');
  });

  it('inverts faint hover tints but keeps dialog scrims dark', () => {
    expect(darkValue('background', 'rgba(37, 77, 55, 0.07)')).toMatch(/^rgba\(2\d\d, /);
    expect(darkValue('background', 'rgba(16, 37, 23, 0.38)')).toBe('rgba(16, 37, 23, 0.38)');
  });

  it('darkens light text on accent fills and keeps coloured badges', () => {
    expect(dark('.primary { background: var(--green); color: white; }')).toMatch(
      /^:where\(:root\[data-theme='dark'\]\) \.primary \{ color: #[0-3]/,
    );
    expect(dark('.badge { background: #c04f3a; color: #fff; }')).toBe('');
  });

  it('leaves keyframes, hand-written dark rules and marked rules alone', () => {
    expect(dark('@keyframes a { from { color: #000 } }')).toBe('');
    expect(dark(":root[data-theme='dark'] .a { color: #000 }")).toBe('');
    expect(dark('.a { /* theme: keep */ color: #000 }')).toBe('');
  });
});
