import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { canAccessPath } from '../../routing/routeTable';
import { listApparatus } from '../apparatus/api';
import { listMembers } from '../personnel/api';
import type { AssignedToType } from './types';

/**
 * "Member · Casey Nolan" / "Apparatus · Engine 301" for an equipment assignment, instead of
 * "MEMBER · m-1". Each list is read only by a role whose route table grants it (an APPARATUS
 * officer can't list members), and the id is the fallback while loading or without access.
 */
export function useAssignmentLabel(): (type?: AssignedToType, id?: string) => string {
  const auth = useAuth();
  const members = useQuery({
    queryKey: ['personnel', 'members'],
    queryFn: () => listMembers(auth),
    enabled: canAccessPath('/personnel', auth.roles),
  });
  const apparatus = useQuery({
    queryKey: ['apparatus'],
    queryFn: () => listApparatus(auth),
    enabled: canAccessPath('/apparatus', auth.roles),
  });

  return (type, id) => {
    if (!type || !id) return 'Unassigned';
    if (type === 'MEMBER') {
      const member = members.data?.find((m) => m.memberId === id);
      return `Member · ${member ? `${member.firstName} ${member.lastName}` : id}`;
    }
    const unit = apparatus.data?.find((a) => a.apparatusId === id);
    return `Apparatus · ${unit?.unitId ?? id}`;
  };
}
