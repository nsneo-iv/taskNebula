import {
  getClientCredentials,
  type ClientCredentials,
} from '@/lib/integrations/client-credentials';

export const LOGIN_OAUTH_PROVIDERS = ['github', 'google', 'oidc'] as const;

export type LoginOAuthProvider = (typeof LOGIN_OAUTH_PROVIDERS)[number];

export type LoginOAuthProviderMap<T> = Record<LoginOAuthProvider, T>;

export type LoginOAuthAvailability = LoginOAuthProviderMap<boolean>;

export type LoginOAuthCredentialsMap = LoginOAuthProviderMap<ClientCredentials | OidcClientCredentials | null>;

/** Env-driven OpenID Connect (Entra ID, Okta, Keycloak, ...) client. */
export type OidcClientCredentials = {
  clientId: string;
  clientSecret: string;
  issuer: string;
  /** Optional display name for the sign-in button / site name. */
  name: string | null;
};

export function isLoginOAuthProvider(value: unknown): value is LoginOAuthProvider {
  return typeof value === 'string' && (LOGIN_OAUTH_PROVIDERS as readonly string[]).includes(value);
}

function readEnv(name: string): string | null {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = readEnv(name);
  if (value === null) return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * Resolve the OIDC login client from `OIDC_*` environment variables. Like the
 * AD provider, `OIDC_ENABLED=false` disables it explicitly even when the
 * required variables are present.
 */
export function getOidcClientCredentials(): OidcClientCredentials | null {
  const issuer = readEnv('OIDC_ISSUER');
  const clientId = readEnv('OIDC_CLIENT_ID');
  const clientSecret = readEnv('OIDC_CLIENT_SECRET');
  if (!readBooleanEnv('OIDC_ENABLED', true) || !issuer || !clientId || !clientSecret) {
    return null;
  }
  return {
    clientId,
    clientSecret,
    issuer,
    name: readEnv('OIDC_NAME'),
  };
}

export async function getLoginOAuthCredentials(): Promise<LoginOAuthCredentialsMap> {
  const [github, google, oidc] = await Promise.all([
    getClientCredentials('github'),
    getClientCredentials('google'),
    Promise.resolve(getOidcClientCredentials()),
  ]);

  return { github, google, oidc };
}

export async function getLoginOAuthAvailability(): Promise<LoginOAuthAvailability> {
  const credentials = await getLoginOAuthCredentials();

  return {
    github: Boolean(credentials.github),
    google: Boolean(credentials.google),
    oidc: Boolean(credentials.oidc),
  };
}
