import type { OIDCConfig } from 'next-auth/providers';

type OidcProfile = {
  sub: string;
  email?: string | null;
  email_verified?: boolean;
  name?: string | null;
  preferred_username?: string;
  picture?: string | null;
};

/**
 * Generic OpenID Connect provider (Entra ID, Okta, Keycloak, Authentik, ...).
 *
 * Auth.js ships per-vendor providers but no generic `oidc` entry point, so we
 * build one on top of the `OIDCConfig` type: discovery via `issuer`,
 * PKCE + state checks, and the standard `openid email profile` scope.
 */
export function OidcProvider(options: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  name?: string;
}): OIDCConfig<OidcProfile> {
  return {
    id: 'oidc',
    name: options.name ?? 'SSO',
    type: 'oidc',
    issuer: options.issuer,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    checks: ['state', 'pkce'],
    authorization: { params: { scope: 'openid email profile' } },
    profile(profile) {
      return {
        id: profile.sub,
        name: profile.name ?? profile.preferred_username ?? profile.sub,
        email: profile.email ?? null,
        image: profile.picture ?? null,
      };
    },
  };
}