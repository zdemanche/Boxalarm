import type { ReactNode } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { Button } from './Button';
import styles from './Dialog.module.css';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
}

export function Dialog({ open, onOpenChange, title, description, children, footer }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content className={styles.content}>
          <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
          {description ? (
            <RadixDialog.Description className={styles.description}>
              {description}
            </RadixDialog.Description>
          ) : null}
          {children}
          {footer ? <div className={styles.footer}>{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names the object and the consequence — design.draft.md §4.5. */
  title: string;
  consequence: string;
  confirmLabel: string;
  onConfirm: () => void;
  danger?: boolean;
}

/** Irreversible, high-blast-radius confirmation (§4.5). No password/step-up prompt is ever
 * added here — Cedar role check alone gates the action, per the product's settled auth model. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  consequence,
  confirmLabel,
  onConfirm,
  danger = false,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={consequence}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
