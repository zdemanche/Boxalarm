import * as RadixDialog from '@radix-ui/react-dialog';
import { useAuth } from '../auth/AuthContext';
import { NavListContent } from './PrimaryNav';
import { IconButton } from './ui/Button';
import { X } from './ui/icons';
import styles from './AppShell.module.css';

interface NavDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Below `md` (767px and narrower) and at high browser zoom, PrimaryNav's static sidebar is
 * `display: none` (AppShell.module.css). This is its replacement: a focus-trapped drawer opened
 * from TopBar's hamburger button, built on Radix Dialog (already a dependency) for correct focus
 * trapping, Escape-to-close, and focus restore to the trigger on close.
 *
 * MAJOR-1 (PR #318 review): previously there was no replacement at all below 768px, so the web
 * app had no route navigation and no Sign out on a phone, or at 200% zoom on a 1280px window
 * (WCAG 1.4.10 Reflow). docs/design.md:286 already specified "Sidebar collapses to a top
 * drawer" — this wires that up.
 */
export function NavDrawer({ open, onOpenChange }: NavDrawerProps) {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) return null;

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.drawerOverlay} />
        <RadixDialog.Content className={styles.drawerContent}>
          <RadixDialog.Title className="visually-hidden">Navigation</RadixDialog.Title>
          <RadixDialog.Description className="visually-hidden">
            Primary navigation and sign out.
          </RadixDialog.Description>
          <RadixDialog.Close asChild>
            <IconButton
              icon={X}
              label="Close navigation"
              size="sm"
              className={styles.drawerClose}
            />
          </RadixDialog.Close>
          <nav aria-label="Primary" className={styles.drawerNav}>
            <NavListContent onNavigate={() => onOpenChange(false)} />
          </nav>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
