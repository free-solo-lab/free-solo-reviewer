import { useEffect } from 'react';
import { t } from '../shared/i18n';

/**
 * ⌘↓ / ⌘↑ (Ctrl on other systems) open the next or previous item of the page's side menu:
 * files of the tree, scenarios, contracts, SQL scripts or tests — whatever the menu lists.
 * ⌘← / ⌘→ move between the changes of the open file, also in the code drawer.
 */
export function useMenuKeys() {
  useEffect(() => {
    const step = (event: KeyboardEvent) => {
      if (!event.key.startsWith('Arrow')) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      // An open window (the code drawer, a dialog) takes the keys; the page behind it does not.
      const scope = document.querySelector<HTMLElement>('[role="dialog"]') ?? document;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const button = [
          ...scope.querySelectorAll<HTMLButtonElement>(
            `.source-change-navigation button[aria-label="${event.key === 'ArrowLeft' ? t('Previous change') : t('Next change')}"]`,
          ),
        ].find((item) => item.offsetParent !== null);
        if (!button) return;
        event.preventDefault();
        if (!button.disabled) button.click();
        return;
      }
      if (scope !== document) return;
      const items = [
        ...document.querySelectorAll<HTMLElement>('.secondary-menu [data-menu-item]'),
      ].filter((item) => item.offsetParent !== null);
      if (!items.length) return;
      event.preventDefault();
      const current = items.findIndex((item) => item.hasAttribute('aria-current'));
      const next =
        event.key === 'ArrowDown'
          ? items[current < 0 ? 0 : Math.min(current + 1, items.length - 1)]
          : items[current < 0 ? items.length - 1 : Math.max(current - 1, 0)];
      if (next === items[current]) return;
      next.scrollIntoView({ block: 'nearest' });
      next.click();
    };
    window.addEventListener('keydown', step, true);
    return () => window.removeEventListener('keydown', step, true);
  }, []);
}
