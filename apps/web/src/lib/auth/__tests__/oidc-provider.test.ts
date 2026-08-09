import { OidcProvider } from '../oidc-provider';

describe('OidcProvider', () => {
  it('exposes the generic oidc provider contract', () => {
    const provider = OidcProvider({
      issuer: 'https://idp.example.com/realms/corp',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      name: 'Corp SSO',
    });

    expect(provider.id).toBe('oidc');
    expect(provider.type).toBe('oidc');
    expect(provider.name).toBe('Corp SSO');
    expect(provider.issuer).toBe('https://idp.example.com/realms/corp');
    expect(provider.clientId).toBe('client-id');
    expect(provider.clientSecret).toBe('client-secret');
    expect(provider.checks).toEqual(['state', 'pkce']);
    expect(provider.authorization).toEqual({ params: { scope: 'openid email profile' } });
  });

  it('falls back to a default display name', () => {
    expect(
      OidcProvider({
        issuer: 'https://idp.example.com/realms/corp',
        clientId: 'client-id',
        clientSecret: 'client-secret',
      }).name
    ).toBe('SSO');
  });

  it('maps a standard OIDC profile to the Auth.js user shape', () => {
    const provider = OidcProvider({
      issuer: 'https://idp.example.com/realms/corp',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });

    const user = provider.profile!({
      sub: 'user-123',
      name: 'Alice SSO',
      email: 'alice@example.com',
      email_verified: true,
      picture: 'https://example.com/alice.png',
      preferred_username: 'alice',
    } as never);

    expect(user).toEqual({
      id: 'user-123',
      name: 'Alice SSO',
      email: 'alice@example.com',
      image: 'https://example.com/alice.png',
    });
  });

  it('derives name from preferred_username and keeps missing fields nullable', () => {
    const provider = OidcProvider({
      issuer: 'https://idp.example.com/realms/corp',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });

    const user = provider.profile!({ sub: 'user-123', preferred_username: 'alice' } as never);

    expect(user).toEqual({
      id: 'user-123',
      name: 'alice',
      email: null,
      image: null,
    });
  });
});