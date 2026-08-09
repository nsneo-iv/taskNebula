jest.mock('@paralleldrive/cuid2', () => ({
  createId: () => 'generated-ad-user-id',
}));

jest.mock('@tasknebula/db', () => ({
  accounts: {
    userId: 'accounts.userId',
    type: 'accounts.type',
    provider: 'accounts.provider',
    providerAccountId: 'accounts.providerAccountId',
  },
  db: {
    query: {
      users: {
        findFirst: jest.fn(),
      },
    },
    insert: jest.fn(),
  },
  users: {
    id: 'users.id',
    email: 'users.email',
    name: 'users.name',
    status: 'users.status',
  },
}));

jest.mock('drizzle-orm', () => ({
  eq: (left: unknown, right: unknown) => ({ type: 'eq', left, right }),
}));

type MockLdapClient = {
  bind: jest.Mock;
  search: jest.Mock;
  unbind: jest.Mock;
};

/**
 * Shared, per-test mutable state that the `ldapts` mock reads at call time.
 * Reinitialised in each `beforeEach` so tests can arrange the directory
 * BEFORE `authenticateAdUser` instantiates its clients.
 */
const ldapMockState: {
  clients: MockLdapClient[];
  searchEntries: unknown[];
  passwordBindError: Error | null;
} = {
  clients: [],
  searchEntries: [],
  passwordBindError: null,
};

function resetLdapMockState() {
  ldapMockState.clients = [];
  ldapMockState.searchEntries = [];
  ldapMockState.passwordBindError = null;
}

jest.mock('ldapts', () => {
  const actual = jest.requireActual('ldapts');
  return {
    Client: jest.fn().mockImplementation(() => {
      const client: MockLdapClient = {
        bind: jest.fn().mockImplementation(() =>
          ldapMockState.passwordBindError
            ? Promise.reject(ldapMockState.passwordBindError)
            : Promise.resolve(undefined)
        ),
        search: jest.fn().mockImplementation(() =>
          Promise.resolve({
            searchEntries: ldapMockState.searchEntries,
            searchReferences: [],
          })
        ),
        unbind: jest.fn().mockResolvedValue(undefined),
      };
      ldapMockState.clients.push(client);
      return client;
    }),
    escapeFilter: actual.escapeFilter,
  };
});

import { db } from '@tasknebula/db';
import {
  authenticateAdUser,
  buildUserFilter,
  getAdAuthConfig,
  isAdAuthEnabled,
  resolveAdDatabaseUser,
} from '../ad-auth';

const ORIGINAL_ENV = { ...process.env };

function setAdEnv(overrides: Record<string, string | undefined> = {}) {
  process.env.AD_LDAP_URL = 'ldap://dc.corp.example.com:389';
  process.env.AD_LDAP_SEARCH_BASE = 'DC=corp,DC=example,DC=com';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearAdEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AD_')) delete process.env[key];
  }
}

function entry(dn: string, attributes: Record<string, unknown>) {
  return { dn, attributes };
}

function arrangeSearchInstance(entries: unknown[]) {
  ldapMockState.searchEntries = entries;
}

function arrangeRejectedPasswordBind() {
  ldapMockState.passwordBindError = new Error('49 INVALID_CREDENTIALS');
}

describe('AD auth configuration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearAdEnv();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('is disabled when the required env vars are missing', () => {
    expect(isAdAuthEnabled()).toBe(false);
    expect(getAdAuthConfig().enabled).toBe(false);
  });

  it('is enabled when URL + search base are present', () => {
    setAdEnv();
    expect(isAdAuthEnabled()).toBe(true);
    const config = getAdAuthConfig();
    expect(config.url).toBe('ldap://dc.corp.example.com:389');
    expect(config.autoProvision).toBe(true);
  });

  it('respects an explicit AD_ENABLED=false override', () => {
    setAdEnv({ AD_ENABLED: 'false' });
    expect(isAdAuthEnabled()).toBe(false);
  });

  it('applies the default user filter and AD_* overrides', () => {
    setAdEnv({
      AD_LDAP_MAIL_ATTRIBUTE: 'userPrincipalName',
      AD_LDAP_REQUIRED_GROUP: 'CN=TaskNebula Users,OU=Groups,DC=corp,DC=example,DC=com',
      AD_AUTO_PROVISION: 'false',
    });
    const config = getAdAuthConfig();
    expect(config.mailAttribute).toBe('userPrincipalName');
    expect(config.requiredGroup).toBe('CN=TaskNebula Users,OU=Groups,DC=corp,DC=example,DC=com');
    expect(config.autoProvision).toBe(false);
    expect(config.userFilter).toContain('sAMAccountName={{username}}');
  });
});

describe('buildUserFilter', () => {
  it('escapes LDAP special characters from the username', () => {
    const filter = buildUserFilter('(|(sAMAccountName={{username}}))', 'a*b(c)');
    expect(filter).toBe('(|(sAMAccountName=a\\2ab\\28c\\29))');
  });
});

describe('authenticateAdUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetLdapMockState();
    clearAdEnv();
    setAdEnv();
  });

  it('returns an identity when lookup + password bind succeed', async () => {
    arrangeSearchInstance([
      entry('CN=Alice Smith,OU=Users,DC=corp,DC=example,DC=com', {
        mail: 'alice@corp.example.com',
        displayName: 'Alice Smith',
      }),
    ]);

    const identity = await authenticateAdUser('alice.smith', 'CorrectHorseBatteryStaple');

    expect(identity).toEqual({
      dn: 'CN=Alice Smith,OU=Users,DC=corp,DC=example,DC=com',
      email: 'alice@corp.example.com',
      name: 'Alice Smith',
    });
    expect(ldapMockState.clients[1].bind).toHaveBeenCalledWith(
      'CN=Alice Smith,OU=Users,DC=corp,DC=example,DC=com',
      'CorrectHorseBatteryStaple'
    );
  });

  it('binds with the service account when configured', async () => {
    setAdEnv({
      AD_LDAP_BIND_DN: 'CN=svc-tasknebula,OU=Service Accounts,DC=corp,DC=example,DC=com',
      AD_LDAP_BIND_PASSWORD: 'service-secret',
    });
    arrangeSearchInstance([
      entry('CN=Alice Smith,OU=Users,DC=corp,DC=example,DC=com', {
        mail: 'alice@corp.example.com',
      }),
    ]);

    await authenticateAdUser('alice.smith', 'pw');

    expect(ldapMockState.clients[0].bind).toHaveBeenCalledWith(
      'CN=svc-tasknebula,OU=Service Accounts,DC=corp,DC=example,DC=com',
      'service-secret'
    );
  });

  it('rejects wrong passwords', async () => {
    arrangeSearchInstance([
      entry('CN=Alice Smith,OU=Users,DC=corp,DC=example,DC=com', {
        mail: 'alice@corp.example.com',
      }),
    ]);
    arrangeRejectedPasswordBind();

    await expect(authenticateAdUser('alice.smith', 'wrong-password')).resolves.toBeNull();
  });

  it('requires exactly one matching entry', async () => {
    arrangeSearchInstance([
      entry('CN=Alice Smith,OU=Users,DC=corp,DC=example,DC=com', {
        mail: 'alice@corp.example.com',
      }),
      entry('CN=Alice B Smith,OU=Contractors,DC=corp,DC=example,DC=com', {
        mail: 'alice.b@corp.example.com',
      }),
    ]);

    await expect(authenticateAdUser('alice', 'pw')).resolves.toBeNull();
  });

  it('enforces the required group membership', async () => {
    setAdEnv({
      AD_LDAP_REQUIRED_GROUP: 'CN=TaskNebula Users,OU=Groups,DC=corp,DC=example,DC=com',
    });
    arrangeSearchInstance([
      entry('CN=Alice Smith,OU=Users,DC=corp,DC=example,DC=com', {
        mail: 'alice@corp.example.com',
        memberOf: ['CN=Marketing,OU=Groups,DC=corp,DC=example,DC=com'],
      }),
    ]);

    await expect(authenticateAdUser('alice.smith', 'pw')).resolves.toBeNull();
  });

  it('accepts members of the required group (DN case-insensitive)', async () => {
    setAdEnv({
      AD_LDAP_REQUIRED_GROUP: 'CN=TaskNebula Users,OU=Groups,DC=corp,DC=example,DC=com',
    });
    arrangeSearchInstance([
      entry('CN=Alice Smith,OU=Users,DC=corp,DC=example,DC=com', {
        mail: 'alice@corp.example.com',
        memberOf: ['cn=tasknebula users,ou=groups,dc=corp,dc=example,dc=com'],
      }),
    ]);

    const identity = await authenticateAdUser('alice.smith', 'pw');
    expect(identity?.email).toBe('alice@corp.example.com');
  });

  it('derives the email from AD_EMAIL_DOMAIN when mail is absent', async () => {
    setAdEnv({ AD_EMAIL_DOMAIN: 'corp.example.com' });
    arrangeSearchInstance([
      entry('CN=Alice Smith,OU=Users,DC=corp,DC=example,DC=com', {
        sAMAccountName: 'alice.smith',
      }),
    ]);

    const identity = await authenticateAdUser('alice.smith', 'pw');
    expect(identity?.email).toBe('alice.smith@corp.example.com');
  });

  it('fails closed when AD is disabled', async () => {
    clearAdEnv();
    await expect(authenticateAdUser('alice.smith', 'pw')).resolves.toBeNull();
  });
});

describe('resolveAdDatabaseUser', () => {
  const findFirstMock = (db.query.users.findFirst as jest.Mock);
  const insertMock = (db.insert as jest.Mock);

  /** `values` spy of the current insert chain, captured at call time. */
  let captureInsertValues: () => jest.Mock;

  function insertUserReturning(row: unknown) {
    return {
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([row]),
        }),
      }),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    resetLdapMockState();
    clearAdEnv();
    setAdEnv();
    let currentValuesMock: jest.Mock;
    captureInsertValues = () => currentValuesMock;
    insertMock.mockImplementation(() => {
      currentValuesMock = jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([]),
        }),
      });
      return { values: currentValuesMock };
    });
  });

  it('links and returns an existing active user', async () => {
    findFirstMock.mockResolvedValue({
      id: 'user-1',
      email: 'alice@corp.example.com',
      name: 'Alice Smith',
      status: 'active',
    });

    const user = await resolveAdDatabaseUser({
      dn: 'CN=Alice Smith,OU=Users,DC=corp,DC=example,DC=com',
      email: 'alice@corp.example.com',
      name: 'Alice Smith',
    });

    expect(user?.id).toBe('user-1');
    expect(captureInsertValues()).toHaveBeenCalledWith({
      userId: 'user-1',
      type: 'ad',
      provider: 'ad',
      providerAccountId: 'CN=Alice Smith,OU=Users,DC=corp,DC=example,DC=com',
    });
  });

  it('rejects inactive users', async () => {
    findFirstMock.mockResolvedValue({
      id: 'user-1',
      email: 'alice@corp.example.com',
      name: 'Alice Smith',
      status: 'inactive',
    });

    await expect(
      resolveAdDatabaseUser({
        dn: 'CN=Alice Smith,OU=Users,DC=corp,DC=example,DC=com',
        email: 'alice@corp.example.com',
        name: 'Alice Smith',
      })
    ).resolves.toBeNull();
  });

  it('creates the user on first login when provisioning is on', async () => {
    findFirstMock.mockResolvedValue(null);
    insertMock.mockImplementation(() => insertUserReturning({
      id: 'generated-ad-user-id',
      email: 'alice@corp.example.com',
      name: 'Alice Smith',
      status: 'active',
    }));

    const user = await resolveAdDatabaseUser({
      dn: 'CN=Alice Smith,OU=Users,DC=corp,DC=example,DC=com',
      email: 'alice@corp.example.com',
      name: 'Alice Smith',
    });

    expect(user).toEqual({
      id: 'generated-ad-user-id',
      email: 'alice@corp.example.com',
      name: 'Alice Smith',
      status: 'active',
    });
    expect(insertMock).toHaveBeenCalled();
  });

  it('does not provision when AD_AUTO_PROVISION=false', async () => {
    setAdEnv({ AD_AUTO_PROVISION: 'false' });
    findFirstMock.mockResolvedValue(null);

    await expect(
      resolveAdDatabaseUser({
        dn: 'CN=Alice Smith,OU=Users,DC=corp,DC=example,DC=com',
        email: 'alice@corp.example.com',
        name: 'Alice Smith',
      })
    ).resolves.toBeNull();
    expect(insertMock).not.toHaveBeenCalled();
  });
});