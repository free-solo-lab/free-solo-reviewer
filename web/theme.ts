import { useEffect, useState } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
const key = 'theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

function stored(): ThemeChoice {
  try {
    const value = localStorage.getItem(key);
    if (value === 'light' || value === 'dark') return value;
  } catch {}
  return 'system';
}
function apply(choice: ThemeChoice) {
  const dark = choice === 'dark' || (choice === 'system' && media().matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/** The chosen colour theme; `system` follows the OS setting. public/theme.js applies it before the first paint. */
export function useTheme() {
  const [choice, setChoice] = useState(stored);
  useEffect(() => {
    apply(choice);
    try {
      if (choice === 'system') localStorage.removeItem(key);
      else localStorage.setItem(key, choice);
    } catch {}
    if (choice !== 'system') return;
    const query = media();
    const follow = () => apply('system');
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, [choice]);
  return [choice, setChoice] as const;
}
