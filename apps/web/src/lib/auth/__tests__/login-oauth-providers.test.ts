const getClientCredentialsMock = jest.fn();

jest.mock('@/lib/integrations/client-credentials', () => ({
  getClientCredentials: (...args: unknown[]) => getClientCredentialsMock(...args),
}));

import {
  getLoginOAuthAvailability,
  getOidcClientCredentials,
  isLoginOAuthProvider,
} from '@/lib/auth/login-oauth-providers';

describe('login OAuth provider settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    delete process.env.OIDC_NAME;
    delete process.env.OIDC_ENABLED;
  });

  it('recognizes only login OAuth providers', () => {
    expect(isLoginOAuthProvider('github')).toBe(true);
    expect(isLoginOAuthProvider('google')).toBe(true);
    expect(isLoginOAuthProvider('oidc')).toBe(true);
    expect(isLoginOAuthProvider('slack')).toBe(false);
  });

  it('marks providers available only when credentials resolve', async () => {
    getClientCredentialsMock.mockImplementation(async (provider: string) =>
      provider === 'github'
        ? {
            provider,
            clientId: 'github-client',
            clientSecret: 'github-secret',
            redirectUri: null,
            scope: null,
            source: 'db',
          }
        : null
    );

    await expect(getLoginOAuthAvailability()).resolves.toEqual({
      github: true,
      google: false,
      oidc: false,
    });
    expect(getClientCredentialsMock).toHaveBeenCalledWith('github');
    expect(getClientCredentialsMock).toHaveBeenCalledWith('google');
  });

  it('marks the OIDC provider available when env credentials are set', async () => {
    getClientCredentialsMock.mockResolvedValue(null);
    process.env.OIDC_ISSUER = 'https://idp.example.com/realms/corp';
    process.env.OIDC_CLIENT_ID = 'tasknebula-client';
    process.env.OIDC_CLIENT_SECRET = 'secret-value';
    process.env.OIDC_NAME = 'Corp SSO';

    await expect(getLoginOAuthAvailability()).resolves.toEqual({
      github: false,
      google: false,
      oidc: true,
    });
  });

  it('resolves OIDC credentials with an optional display name', () => {
    getClientCredentialsMock.mockResolvedValue(null);
    process.env.OIDC_ISSUER = 'https://idp.example.com/realms/corp';
    process.env.OIDC_CLIENT_ID = 'tasknebula-client';
    process.env.OIDC_CLIENT_SECRET = 'secret-value';
    process.env.OIDC_NAME = 'Corp SSO';

    expect(getOidcClientCredentials()).toEqual({
      clientId: 'tasknebula-client',
      clientSecret: 'secret-value',
      issuer: 'https://idp.example.com/realms/corp',
      name: 'Corp SSO',
    });
  });

  it('falls back to a null name when OIDC_NAME is unset', () => {
    process.env.OIDC_ISSUER = 'https://idp.example.com/realms/corp';
    process.env.OIDC_CLIENT_ID = 'tasknebula-client';
    process.env.OIDC_CLIENT_SECRET = 'secret-value';

    expect(getOidcClientCredentials()?.name).toBeNull();
  });

  it('ignores OIDC env config when OIDC_ENABLED=false', () => {
    process.env.OIDC_ISSUER = 'https://idp.example.com/realms/corp';
    process.env.OIDC_CLIENT_ID = 'tasknebula-client';
    process.env.OIDC_CLIENT_SECRET = 'secret-value';
    process.env.OIDC_ENABLED = 'false';

    expect(getOidcClientCredentials()).toBeNull();
  });

  it('returns null when any required OIDC env var is missing', () => {
    process.env.OIDC_ISSUER = 'https://idp.example.com/realms/corp';
    process.env.OIDC_CLIENT_ID = 'tasknebula-client';

    expect(getOidcClientCredentials()).toBeNull();
  });
});