'use client';

import { signIn } from 'next-auth/react';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AUTH_INPUT_CLASS_NAME,
  AuthFormAlert,
  AuthDivider,
} from './auth-ui';
import { acceptProjectInviteAfterSignIn, normalizeCallbackUrl } from './signin-utils';

/**
 * Windows Active Directory sign-in. Rendered by the sign-in page only when
 * the platform has AD configured (AD_ENABLED + AD_LDAP_URL + search base).
 * Credentials are validated server-side by the `ad` NextAuth provider.
 */
export function ADSignInForm({
  dividerLabel,
  showDivider = true,
}: {
  dividerLabel: string;
  showDivider?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tAuth = useTranslations('auth');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const projectInviteToken = searchParams?.get('projectInviteToken') || null;
  const callbackUrl = normalizeCallbackUrl(searchParams?.get('callbackUrl'));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await signIn('ad', {
        username,
        password,
        redirect: false,
      });

      if (result?.error) {
        setError(tAuth('invalid_credentials'));
      } else {
        const redirectTo = await acceptProjectInviteAfterSignIn(projectInviteToken, callbackUrl);
        router.push(redirectTo);
        router.refresh();
      }
    } catch {
      setError(tAuth('generic_error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-7">
      {showDivider ? <AuthDivider>{dividerLabel}</AuthDivider> : null}

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="ad-username">{tAuth('ad_username_label')}</Label>
          <Input
            id="ad-username"
            type="text"
            className={AUTH_INPUT_CLASS_NAME}
            placeholder={tAuth('ad_username_placeholder')}
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              if (error) setError('');
            }}
            required
            autoComplete="username"
            aria-invalid={!!error}
            aria-describedby={error ? 'ad-signin-form-error' : undefined}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="ad-password">{tAuth('password_label')}</Label>
          <Input
            id="ad-password"
            type="password"
            className={AUTH_INPUT_CLASS_NAME}
            placeholder={tAuth('password_placeholder')}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError('');
            }}
            required
            autoComplete="current-password"
            aria-invalid={!!error}
            aria-describedby={error ? 'ad-signin-form-error' : undefined}
          />
        </div>

        {error ? <AuthFormAlert id="ad-signin-form-error">{error}</AuthFormAlert> : null}

        <Button type="submit" className="w-full text-sm" size="xl" disabled={loading}>
          {loading ? tAuth('ad_sign_in_loading') : tAuth('ad_sign_in')}
        </Button>
      </form>
    </div>
  );
}