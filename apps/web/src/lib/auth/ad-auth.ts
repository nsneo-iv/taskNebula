/**
 * Windows Active Directory (LDAP) authentication.
 *
 * Sign-in flow:
 *   1. The user enters a domain identity (sAMAccountName or UPN) + password.
 *   2. We look the account up under `AD_LDAP_SEARCH_BASE` with the AD user
 *      filter (service bind via `AD_LDAP_BIND_DN` / `AD_LDAP_BIND_PASSWORD`
 *      when configured, anonymous otherwise).
 *   3. The entry must resolve to exactly one directory object; we verify the
 *      end-user credentials by LDAP-binding as that entry's DN.
 *   4. Optionally require membership in `AD_LDAP_REQUIRED_GROUP` via
 *      `memberOf`.
 *   5. The identity (`mail`, display name, DN) is mapped to a TaskNebula user
 *      by the `ad` auth provider; `AD_AUTO_PROVISION=false` disables
 *      first-login account creation.
 *
 * Config is env-driven (`AD_*`). When required variables are absent AD
 * sign-in is disabled and the login screen hides the domain section.
 */
import { Client, escapeFilter } from 'ldapts';
import { createId } from '@paralleldrive/cuid2';
import { accounts, db, users } from '@tasknebula/db';
import { eq } from 'drizzle-orm';

export const AD_ACCOUNT_PROVIDER = 'ad';

/** `{{username}}` is substituted with the escaped user input. */
export const DEFAULT_AD_USER_FILTER =
  '(&(objectClass=user)(|(sAMAccountName={{username}})(userPrincipalName={{username}})))';

export type AdAuthConfig = {
  enabled: boolean;
  url: string | null;
  bindDn: string | null;
  bindPassword: string | null;
  searchBase: string | null;
  userFilter: string;
  mailAttribute: string;
  nameAttribute: string;
  requiredGroup: string | null;
  emailDomain: string | null;
  autoProvision: boolean;
};

export type AdIdentity = {
  /** Distinguished name of the directory object, used as the account link. */
  dn: string;
  email: string;
  name: string | null;
};

type AdDirectoryEntry = Record<string, unknown> & {
  dn?: unknown;
  attributes?: Record<string, unknown>;
};

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
 * Resolve the AD configuration from environment variables. The provider is
 * enabled only when both a server URL and a search base are present; setting
 * `AD_ENABLED=false` explicitly disables it even when the other vars exist.
 */
export function getAdAuthConfig(): AdAuthConfig {
  const url = readEnv('AD_LDAP_URL');
  const searchBase = readEnv('AD_LDAP_SEARCH_BASE');

  return {
    enabled: readBooleanEnv('AD_ENABLED', true) && url !== null && searchBase !== null,
    url,
    bindDn: readEnv('AD_LDAP_BIND_DN'),
    bindPassword: readEnv('AD_LDAP_BIND_PASSWORD'),
    searchBase,
    userFilter: readEnv('AD_LDAP_USER_FILTER') ?? DEFAULT_AD_USER_FILTER,
    mailAttribute: readEnv('AD_LDAP_MAIL_ATTRIBUTE') ?? 'mail',
    nameAttribute: readEnv('AD_LDAP_NAME_ATTRIBUTE') ?? 'displayName',
    requiredGroup: readEnv('AD_LDAP_REQUIRED_GROUP'),
    emailDomain: readEnv('AD_EMAIL_DOMAIN'),
    autoProvision: readBooleanEnv('AD_AUTO_PROVISION', true),
  };
}

/** Cheap availability check for the login screen / route responses. */
export function isAdAuthEnabled(): boolean {
  return getAdAuthConfig().enabled;
}

/** Substitute the escaped username into a configurable LDAP filter. */
export function buildUserFilter(template: string, username: string): string {
  // ldapts' escapeFilter is a tagged-template helper that escapes only the
  // interpolated values, which is exactly what we want for user input.
  return template.replace(/\{\{username\}\}/g, () => escapeFilter`${username}`);
}

/**
 * Resolve the value of an entry attribute. ldapts v8 surfaces requested
 * attributes as top-level properties of the entry (`entry.mail`, ...);
 * older shapes nest them under `entry.attributes`. Supporting both keeps
 * this robust across ldapts versions and mocked directory entries.
 */
function entryValue(entry: AdDirectoryEntry, name: string): unknown {
  const nested = entry.attributes?.[name];
  if (nested !== undefined && nested !== null) return nested;
  const topLevel = (entry as unknown as Record<string, unknown>)[name];
  return topLevel ?? null;
}

function entryDn(entry: AdDirectoryEntry): string {
  const dn = entryValue(entry, 'distinguishedName') ?? entry.dn;
  const raw = Array.isArray(dn) ? dn[0] : dn;
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : '';
  return text.trim();
}

/** First (string) value of an attribute, decoding Buffers from ldapts. */
function attributeFirst(entry: AdDirectoryEntry, name: string): string | null {
  const value = entryValue(entry, name);
  if (value === null) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  return typeof raw === 'string' ? raw : null;
}

function attributeList(entry: AdDirectoryEntry, name: string): string[] {
  const value = entryValue(entry, name);
  if (value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  return items
    .filter((item): item is Buffer | string => Buffer.isBuffer(item) || typeof item === 'string')
    .map((item) => (Buffer.isBuffer(item) ? item.toString('utf8') : item));
}

function normalizeGroupDn(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

function isMemberOfGroup(entry: AdDirectoryEntry, requiredGroup: string): boolean {
  const normalizedRequired = normalizeGroupDn(requiredGroup);
  return attributeList(entry, 'memberOf').some(
    (dn) => normalizeGroupDn(dn) === normalizedRequired
  );
}

/**
 * Resolve the directory entry for `username`, verifying the end-user
 * password via a direct LDAP bind. Returns `null` unless exactly one user
 * matches (never guess between ambiguous results) and, when configured, the
 * entry belongs to the required group.
 */
async function findAdEntry(username: string, password: string): Promise<AdDirectoryEntry | null> {
  const config = getAdAuthConfig();
  if (!config.enabled || !config.url || !config.searchBase) return null;

  const client = new Client({ url: config.url, timeout: 10_000, connectTimeout: 10_000 });
  try {
    if (config.bindDn) {
      await client.bind(config.bindDn, config.bindPassword ?? '');
    }

    const { searchEntries } = await client.search(config.searchBase, {
      scope: 'sub',
      filter: buildUserFilter(config.userFilter, username),
      attributes: [
        config.mailAttribute,
        config.nameAttribute,
        'memberOf',
        'sAMAccountName',
        'distinguishedName',
      ],
    });

    if (searchEntries.length !== 1) return null;
    const entry = searchEntries[0] as unknown;
    if (!entry || typeof entry !== 'object') return null;
    const directoryEntry = entry as AdDirectoryEntry;

    if (config.requiredGroup && !isMemberOfGroup(directoryEntry, config.requiredGroup)) {
      return null;
    }

    const dn = entryDn(directoryEntry);
    if (!dn) return null;

    // Verify the end-user's password by binding as their directory object.
    const passwordClient = new Client({
      url: config.url,
      timeout: 10_000,
      connectTimeout: 10_000,
    });
    try {
      await passwordClient.bind(dn, password);
    } catch {
      return null;
    } finally {
      await passwordClient.unbind().catch(() => undefined);
    }

    return directoryEntry;
  } catch {
    return null;
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

/**
 * Map the verified directory entry to a TaskNebula identity. Email comes from
 * the AD `mail` attribute; when the directory has none we derive it from the
 * UPN-style login or `AD_EMAIL_DOMAIN`.
 */
function mapAdIdentity(
  entry: AdDirectoryEntry,
  username: string,
  config: AdAuthConfig
): AdIdentity | null {
  const mail = attributeFirst(entry, config.mailAttribute)?.trim().toLowerCase();
  const email =
    mail && mail.length > 0
      ? mail
      : username.toLowerCase().includes('@')
        ? username.trim().toLowerCase()
        : config.emailDomain
          ? `${username.trim().toLowerCase()}@${config.emailDomain.replace(/^@/, '')}`
          : null;

  if (!email) return null;

  const name =
    attributeFirst(entry, config.nameAttribute)?.trim() || username.trim() || null;

  return { dn: entryDn(entry), email, name };
}

/**
 * Authenticate a user against Active Directory. Returns the mapped identity
 * (email, display name, DN) when lookup + password verification succeed and
 * group constraints (if configured) are satisfied. Returns `null` on every
 * failure path so the auth provider fails closed.
 */
export async function authenticateAdUser(
  username: string,
  password: string
): Promise<AdIdentity | null> {
  const config = getAdAuthConfig();
  if (!config.enabled) return null;

  const normalizedUsername = username.trim();
  if (!normalizedUsername || !password) return null;

  const entry = await findAdEntry(normalizedUsername, password);
  if (!entry) return null;

  return mapAdIdentity(entry, normalizedUsername, config);
}

export type AdDatabaseUser = {
  id: string;
  email: string;
  name: string | null;
  status: 'active' | 'inactive' | 'invited';
};

function toAdDatabaseUser(row: unknown): AdDatabaseUser | null {
  if (!row || typeof row !== 'object') return null;
  const candidate = row as Partial<AdDatabaseUser>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.email !== 'string' ||
    (candidate.status !== 'active' && candidate.status !== 'inactive' && candidate.status !== 'invited')
  ) {
    return null;
  }
  return {
    id: candidate.id,
    email: candidate.email,
    name: typeof candidate.name === 'string' ? candidate.name : null,
    status: candidate.status,
  };
}

async function linkAdAccount(userId: string, dn: string) {
  await db
    .insert(accounts)
    .values({
      userId,
      type: 'ad',
      provider: AD_ACCOUNT_PROVIDER,
      providerAccountId: dn,
    })
    .onConflictDoNothing();
}

/**
 * Find the TaskNebula user backing an authenticated AD identity, creating one
 * on first login when `AD_AUTO_PROVISION` allows it, and record the directory
 * account link. Returns `null` for inactive users and when provisioning is
 * disabled and nobody exists yet.
 */
export async function resolveAdDatabaseUser(identity: AdIdentity): Promise<AdDatabaseUser | null> {
  const existing = await db.query.users.findFirst({
    where: eq(users.email, identity.email),
  });
  const existingUser = toAdDatabaseUser(existing);
  if (existingUser) {
    if (existingUser.status !== 'active') return null;
    await linkAdAccount(existingUser.id, identity.dn);
    return existingUser;
  }

  const config = getAdAuthConfig();
  if (!config.autoProvision) return null;

  const [created] = await db
    .insert(users)
    .values({
      id: createId(),
      email: identity.email,
      name: identity.name,
      status: 'active',
    })
    .onConflictDoNothing()
    .returning({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
    });

  const createdUser = toAdDatabaseUser(created) ?? existingUser;
  if (!createdUser || createdUser.status !== 'active') return null;

  await linkAdAccount(createdUser.id, identity.dn);
  return createdUser;
}