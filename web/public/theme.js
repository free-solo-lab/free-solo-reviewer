// Applies the saved colour theme before the first paint; web/theme.ts keeps it up to date.
try {
  const theme = localStorage.getItem('theme');
  const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
} catch {}
