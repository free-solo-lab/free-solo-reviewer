import { useState, type KeyboardEvent, type ReactNode } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import styles from './Dialog.module.css';

/** The heading that names the dialog; wrap the existing heading element with `asChild`. */
export const DialogTitle = RadixDialog.Title;
/** Closes the dialog; wrap the existing close button with `asChild`. */
export const DialogClose = RadixDialog.Close;

/**
 * A modal dialog or a side drawer that is open while mounted. Focus stays inside, Escape and a
 * click outside close it, and focus returns to where it was.
 */
export function Dialog({
  onClose,
  variant = 'modal',
  className,
  label,
  dismissible = true,
  closeOnOutsideClick = true,
  onKeyDownCapture,
  children,
}: {
  onClose: () => void;
  variant?: 'modal' | 'drawer';
  className?: string;
  /** Accessible name for dialogs whose content has no DialogTitle. */
  label?: string;
  /** False while an action runs: the dialog then ignores Escape and outside clicks. */
  dismissible?: boolean;
  /** False for dialogs with typed input that an accidental click must not discard. */
  closeOnOutsideClick?: boolean;
  onKeyDownCapture?: (event: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  // Opened from state rather than a Radix trigger, so focus returns to what had it on opening.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  return (
    <RadixDialog.Root
      open
      onOpenChange={(open) => {
        if (!open && dismissible) onClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          className={variant === 'drawer' ? styles.drawerOverlay : styles.overlay}
        />
        <RadixDialog.Content
          className={`${variant === 'drawer' ? styles.drawer : styles.centered}${className ? ` ${className}` : ''}`}
          aria-describedby={undefined}
          onKeyDownCapture={onKeyDownCapture}
          onInteractOutside={(event) => {
            if (!closeOnOutsideClick) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener?.isConnected) opener.focus({ preventScroll: true });
          }}
        >
          {label && <RadixDialog.Title className={styles.hiddenTitle}>{label}</RadixDialog.Title>}
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
