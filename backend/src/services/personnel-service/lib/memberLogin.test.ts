import { describe, expect, it, vi } from 'vitest';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  InvalidParameterException,
  UsernameExistsException,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  InvalidMemberEmailError,
  MemberLoginExistsError,
  adoptExistingLogin,
  createMemberLogin,
  readMemberLoginConfig,
  syncRoleGroups,
} from './memberLogin.js';

const CONFIG = { userPoolId: 'us-east-1_pool' };
const INPUT = { email: 'jamie@example.com', deptId: 'NICHOLS' };

function client(send: (command: unknown) => Promise<unknown>): CognitoIdentityProviderClient {
  return { send: vi.fn(send) } as unknown as CognitoIdentityProviderClient;
}

function sentCommands(c: CognitoIdentityProviderClient): unknown[] {
  return (c.send as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => call[0]);
}

const created = { User: { Attributes: [{ Name: 'sub', Value: 'sub-jamie' }] } };

describe('createMemberLogin', () => {
  it('creates the login with custom:deptId, adds it to MEMBER, and returns its sub', async () => {
    const c = client(() => Promise.resolve(created));
    await expect(createMemberLogin(c, CONFIG, INPUT)).resolves.toBe('sub-jamie');
    const commands = sentCommands(c);
    const create = commands[0] as AdminCreateUserCommand;
    expect(create).toBeInstanceOf(AdminCreateUserCommand);
    expect(create.input.Username).toBe('jamie@example.com');
    expect(create.input.UserAttributes).toEqual(
      expect.arrayContaining([{ Name: 'custom:deptId', Value: 'NICHOLS' }]),
    );
    const group = commands[1] as AdminAddUserToGroupCommand;
    expect(group).toBeInstanceOf(AdminAddUserToGroupCommand);
    expect(group.input.GroupName).toBe('MEMBER');
  });

  it('maps an existing username to MemberLoginExistsError', async () => {
    const c = client(() =>
      Promise.reject(new UsernameExistsException({ message: 'exists', $metadata: {} })),
    );
    await expect(createMemberLogin(c, CONFIG, INPUT)).rejects.toBeInstanceOf(
      MemberLoginExistsError,
    );
  });

  it('maps an InvalidParameterException from AdminCreateUser to InvalidMemberEmailError', async () => {
    const c = client(() =>
      Promise.reject(new InvalidParameterException({ message: 'bad email', $metadata: {} })),
    );
    await expect(createMemberLogin(c, CONFIG, INPUT)).rejects.toBeInstanceOf(
      InvalidMemberEmailError,
    );
  });

  it('deletes the login when adding it to the MEMBER group fails', async () => {
    const c = client((command) =>
      command instanceof AdminAddUserToGroupCommand
        ? Promise.reject(new Error('throttled'))
        : Promise.resolve(created),
    );
    await expect(createMemberLogin(c, CONFIG, INPUT)).rejects.toThrow('throttled');
    const last = sentCommands(c).at(-1);
    expect(last).toBeInstanceOf(AdminDeleteUserCommand);
  });
});

describe('adoptExistingLogin', () => {
  const existing = (deptId: string, UserStatus = 'CONFIRMED') =>
    client((command) =>
      Promise.resolve(
        command instanceof AdminGetUserCommand
          ? {
              UserStatus,
              UserAttributes: [
                { Name: 'sub', Value: 'sub-orphan' },
                { Name: 'custom:deptId', Value: deptId },
              ],
            }
          : {},
      ),
    );

  it('returns the sub of a same-department login and re-adds it to MEMBER', async () => {
    const c = existing('NICHOLS');
    await expect(adoptExistingLogin(c, CONFIG, INPUT)).resolves.toBe('sub-orphan');
    const group = sentCommands(c).at(-1) as AdminAddUserToGroupCommand;
    expect(group).toBeInstanceOf(AdminAddUserToGroupCommand);
    expect(group.input).toMatchObject({ Username: 'jamie@example.com', GroupName: 'MEMBER' });
  });

  it('re-sends the invite when the adopted login never set its password', async () => {
    const c = existing('NICHOLS', 'FORCE_CHANGE_PASSWORD');
    await adoptExistingLogin(c, CONFIG, INPUT);
    const resend = sentCommands(c).at(-1) as AdminCreateUserCommand;
    expect(resend).toBeInstanceOf(AdminCreateUserCommand);
    expect(resend.input).toMatchObject({ Username: 'jamie@example.com', MessageAction: 'RESEND' });
  });

  it('sends no invite for an adopted login that is already confirmed', async () => {
    const c = existing('NICHOLS');
    await adoptExistingLogin(c, CONFIG, INPUT);
    expect(sentCommands(c).some((cmd) => cmd instanceof AdminCreateUserCommand)).toBe(false);
  });

  it("refuses another department's login without touching its groups", async () => {
    const c = existing('OTHER');
    await expect(adoptExistingLogin(c, CONFIG, INPUT)).resolves.toBeUndefined();
    expect(sentCommands(c)).toHaveLength(1);
  });
});

describe('readMemberLoginConfig', () => {
  it('requires COGNITO_USER_POOL_ID', () => {
    expect(() => readMemberLoginConfig({})).toThrow('COGNITO_USER_POOL_ID');
    expect(readMemberLoginConfig({ COGNITO_USER_POOL_ID: 'p' })).toEqual({ userPoolId: 'p' });
  });
});

describe('syncRoleGroups', () => {
  function withGroups(groups: string[]) {
    return client((command) =>
      Promise.resolve(
        command instanceof AdminListGroupsForUserCommand
          ? { Groups: groups.map((GroupName) => ({ GroupName })) }
          : {},
      ),
    );
  }

  it('adds missing role groups and removes extra ones, by sub, and reports both', async () => {
    const c = withGroups(['MEMBER', 'TRAINING', 'CHIEF']);
    await expect(syncRoleGroups(c, CONFIG, 'sub-jamie', ['MEMBER', 'OFFICER'])).resolves.toEqual({
      added: ['OFFICER'],
      removed: ['TRAINING', 'CHIEF'],
    });
    const writes = sentCommands(c).slice(1);
    expect(writes[0]).toBeInstanceOf(AdminAddUserToGroupCommand);
    expect(writes.slice(1).every((w) => w instanceof AdminRemoveUserFromGroupCommand)).toBe(true);
    for (const command of sentCommands(c)) {
      expect((command as { input: { Username: string } }).input.Username).toBe('sub-jamie');
    }
  });

  it('never removes a group that is not one of the six roles', async () => {
    const c = withGroups(['MEMBER', 'us-east-1_Google', 'pilot']);
    await expect(syncRoleGroups(c, CONFIG, 'sub-jamie', ['MEMBER'])).resolves.toEqual({
      added: [],
      removed: [],
    });
    expect(sentCommands(c)).toHaveLength(1);
  });
});
