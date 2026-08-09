/**
 * Shared helpers for the sign-in forms (email/password and AD).
 */

export function normalizeCallbackUrl(value: string | null | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  if (value.startsWith('/auth/') || value === '/auth') return null;
  return value;
}

export async function acceptProjectInviteAfterSignIn(
  projectInviteToken: string | null,
  callbackUrl: string | null
) {
  if (!projectInviteToken) return callbackUrl || '/dashboard';

  const response = await fetch('/api/project-invite-links/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectInviteToken }),
  });

  if (!response.ok) return '/dashboard';

  const data = (await response.json().catch(() => ({}))) as { redirectTo?: string };
  return data.redirectTo || '/dashboard';
}