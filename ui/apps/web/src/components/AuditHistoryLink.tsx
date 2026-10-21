import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { canAccessPath } from '../routing/routeTable';
import { buttonClassName } from './ui/Button';
import { History } from './ui/icons';

/** The audit log's lookup for one record, as a link the page can be opened at. */
export function auditLogHref(entityType: string, entityId: string): string {
  const params = new URLSearchParams({ entityType, entityId });
  return `/audit-log?${params.toString()}`;
}

/**
 * "Change history" for the record on screen. The audit trail is read one record at a time
 * (platform/audit needs both the entity type and its ID), so record pages link straight to it
 * rather than asking an administrator to type IDs. Renders nothing for roles that can't open
 * the audit log.
 */
export function AuditHistoryLink({
  entityType,
  entityId,
}: {
  /** The audit trail's mutatedEntityType, e.g. MEMBER or APPARATUS. */
  entityType: string;
  entityId: string;
}) {
  const { roles } = useAuth();
  if (!canAccessPath('/audit-log', roles)) return null;
  return (
    <Link
      to={auditLogHref(entityType, entityId)}
      className={buttonClassName({ variant: 'secondary' })}
    >
      <History size={16} aria-hidden="true" />
      Change history
    </Link>
  );
}
