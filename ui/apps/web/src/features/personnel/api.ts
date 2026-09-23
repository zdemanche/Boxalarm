import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import type { CreateMemberInput, Member, MemberStatus } from './types';

export async function listMembers(tokens: AuthTokenSource): Promise<Member[]> {
  const response = await apiRequest('personnel/members', tokens);
  const body = (await response.json()) as { items: Member[] };
  return body.items;
}

export async function getMember(tokens: AuthTokenSource, memberId: string): Promise<Member> {
  const response = await apiRequest(`personnel/members/${encodeURIComponent(memberId)}`, tokens);
  return (await response.json()) as Member;
}

export async function createMember(
  tokens: AuthTokenSource,
  input: CreateMemberInput,
): Promise<Member> {
  const response = await apiRequest('personnel/members', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as Member;
}

export async function updateMemberStatus(
  tokens: AuthTokenSource,
  memberId: string,
  status: MemberStatus,
): Promise<Member> {
  const response = await apiRequest(
    `personnel/members/${encodeURIComponent(memberId)}/status`,
    tokens,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    },
  );
  return (await response.json()) as Member;
}
