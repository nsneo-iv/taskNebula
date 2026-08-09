'use client';

import { signIn } from 'next-auth/react';
import { useState, useEffect, useMemo, type ComponentType } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { AlertCircle, AlertTriangle, KeyRound, MailCheck, X } from 'lucide-react';
import Link from 'next/link';
import {
  AUTH_INPUT_CLASS_NAME,
  AUTH_STANDALONE_LINK_CLASS_NAME,
  AuthFormAlert,
  AuthIntro,
  AuthLoading,
} from './auth-ui';
import {
  EMPTY_OAUTH_PROVIDER_AVAILABILITY,
  OAuthProviderButtons,
  hasOAuthProviders,
  normalizeOAuthProviderAvailability,
  type OAuthProviderAvailability,
} from './oauth-provider-buttons';
import { ADSignInForm } from './ad-signin-form';
import { acceptProjectInviteAfterSignIn, normalizeCallbackUrl } from './signin-utils';

type BannerTone = 'success' | 'warn' | 'danger';

type StatusBanner = {
  key: string;
  tone: BannerTone;
  icon: ComponentType<{ className?: string }>;
  messageKey:
    | 'banner_email_verified'
    | 'banner_password_reset'
    | 'banner_incorrect_credentials'
    | 'banner_verification_invalid'
    | 'banner_generic_signin_error';
};

function resolveStatusBanner(params: URLSearchParams | null): StatusBanner | null {
  if (!params) return null;

  if (params.get('verified') === '1') {
    return {
      key: 'verified',
      tone: 'success',
      icon: MailCheck,
      messageKey: 'banner_email_verified',
    };
  }

  if (params.get('reset') === '1') {
    return {
      key: 'reset',
      tone: 'success',
      icon: KeyRound,
      messageKey: 'banner_password_reset',
    };
  }

  const errorParam = params.get('error');
  if (errorParam === 'CredentialsSignin') {
    return {
      key: 'error-credentials',
      tone: 'danger',
      icon: AlertCircle,
      messageKey: 'banner_incorrect_credentials',
    };
  }
  if (errorParam === 'Verification') {
    return {
      key: 'error-verification',
      tone: 'warn',
      icon: AlertTriangle,
      messageKey: 'banner_verification_invalid',
    };
  }
  if (errorParam) {
    return {
      key: `error-${errorParam}`,
      tone: 'danger',
      icon: AlertCircle,
      messageKey: 'banner_generic_signin_error',
    };
  }

  return null;
}

const BANNER_TONE_STYLES: Record<BannerTone, string> = {
  success: 'panel-success text-accent-emerald',
  warn: 'panel-warn text-accent-amber',
  danger: 'panel-danger text-destructive',
};

export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tAuth = useTranslations('auth');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checkingSetup, setCheckingSetup] = useState(true);
  const [dismissedBannerKey, setDismissedBannerKey] = useState<string | null>(null);
  const [oauthProviders, setOauthProviders] = useState<OAuthProviderAvailability>(
    EMPTY_OAUTH_PROVIDER_AVAILABILITY
  );
  const [adEnabled, setAdEnabled] = useState(false);
  const [oidcName, setOidcName] = useState<string | null>(null);

  const statusBanner = useMemo(() => resolveStatusBanner(searchParams), [searchParams]);
  const projectInviteToken = searchParams?.get('projectInviteToken') || null;
  const callbackUrl = normalizeCallbackUrl(searchParams?.get('callbackUrl'));
  const activeBanner =
    statusBanner && statusBanner.key !== dismissedBannerKey ? statusBanner : null;

  // Check if setup is needed — redirect before showing login
  useEffect(() => {
    let mounted = true;

    async function loadEntryState() {
      try {
        const [setupResponse, providersResponse] = await Promise.all([
          fetch('/api/setup'),
          fetch('/api/auth/oauth-providers', { cache: 'no-store' }),
        ]);

        const setupData = await setupResponse.json().catch(() => ({}));
        if (!mounted) return;

        if (setupData.setupRequired) {
          router.replace('/setup');
          return;
        }

        const providerData = providersResponse.ok
          ? await providersResponse.json().catch(() => ({}))
          : {};
        if (!mounted) return;

        setOauthProviders(normalizeOAuthProviderAvailability(providerData));
        if (providerData?.oidcName) {
          setOidcName(providerData.oidcName as string);
        }
        if (providerData?.ad === true) {
          setAdEnabled(true);
        }
        setCheckingSetup(false);
      } catch {
        if (!mounted) return;
        setOauthProviders(EMPTY_OAUTH_PROVIDER_AVAILABILITY);
        setCheckingSetup(false);
      }
    }

    loadEntryState();

    return () => {
      mounted = false;
    };
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await signIn('credentials', {
        email,
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

  const hasOAuth = hasOAuthProviders(oauthProviders);
  const loginMethods: ('email' | 'sso' | 'ad')[] = ['email'];
  if (hasOAuth) loginMethods.push('sso');
  if (adEnabled) loginMethods.push('ad');
  const showTabs = loginMethods.length > 1;

  if (checkingSetup) {
    return <AuthLoading label={tAuth('loading')} />;
  }

  const emailForm = (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="email">{tAuth('email_label')}</Label>
        <Input
          id="email"
          type="email"
          className={AUTH_INPUT_CLASS_NAME}
          placeholder={tAuth('email_placeholder')}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (error) setError('');
          }}
          required
          autoComplete="email"
          aria-invalid={!!error}
          aria-describedby={error ? 'signin-form-error' : undefined}
        />
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3">
          <Label htmlFor="password">{tAuth('password_label')}</Label>
          <Link
            href="/auth/forgot-password"
            className={`${AUTH_STANDALONE_LINK_CLASS_NAME} text-xs`}
          >
            {tAuth('forgot_password')}
          </Link>
        </div>
        <Input
          id="password"
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
          aria-describedby={error ? 'signin-form-error' : undefined}
        />
      </div>

      {error ? <AuthFormAlert id="signin-form-error">{error}</AuthFormAlert> : null}

      <Button type="submit" className="w-full text-sm" size="xl" disabled={loading}>
        {loading ? tAuth('signin_loading') : tAuth('signin')}
      </Button>
    </form>
  );

  const signupFooter = (
    <p className="text-muted-foreground flex flex-wrap items-center gap-x-1 text-sm">
      <span>{tAuth('no_account')}</span>
      <Link
        href={
          projectInviteToken
            ? `/auth/signup?projectInviteToken=${encodeURIComponent(projectInviteToken)}`
            : '/auth/signup'
        }
        className={AUTH_STANDALONE_LINK_CLASS_NAME}
      >
        {tAuth('signup')}
      </Link>
    </p>
  );

  return (
    <div className="animate-fade-up space-y-7">
      <AuthIntro title={tAuth('welcome_back')} description={tAuth('subtitle')} />

      {activeBanner && (
        <div
          key={activeBanner.key}
          role={activeBanner.tone === 'success' ? 'status' : 'alert'}
          aria-live="polite"
          className={`${BANNER_TONE_STYLES[activeBanner.tone]} animate-alert-in flex items-start gap-3 px-4 py-3 text-sm`}
        >
          <activeBanner.icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p className="flex-1 leading-snug">{tAuth(activeBanner.messageKey)}</p>
          <Button
            type="button"
            onClick={() => setDismissedBannerKey(activeBanner.key)}
            variant="ghost"
            size="icon-xs"
            className="hover:bg-background/50 -me-1 -mt-1 shrink-0 text-current hover:text-current"
            aria-label={tAuth('dismiss_notification')}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      )}

      {showTabs ? (
        <Tabs defaultValue="email" className="w-full">
          <TabsList
            className={cn(
              'grid w-full',
              loginMethods.length === 2 ? 'grid-cols-2' : 'grid-cols-3'
            )}
          >
            <TabsTrigger value="email">{tAuth('signin_tab_email')}</TabsTrigger>
            {hasOAuth ? (
              <TabsTrigger value="sso">{tAuth('signin_tab_sso')}</TabsTrigger>
            ) : null}
            {adEnabled ? <TabsTrigger value="ad">{tAuth('signin_tab_ad')}</TabsTrigger> : null}
          </TabsList>
          <TabsContent value="email">{emailForm}</TabsContent>
          {hasOAuth ? (
            <TabsContent value="sso">
              <OAuthProviderButtons
                providers={oauthProviders}
                projectInviteToken={projectInviteToken}
                callbackUrl={callbackUrl}
                githubLabel={tAuth('continue_with_github')}
                googleLabel={tAuth('continue_with_google')}
                oidcLabel={tAuth('continue_with_oidc', { name: oidcName ?? 'SSO' })}
              />
            </TabsContent>
          ) : null}
          {adEnabled ? (
            <TabsContent value="ad">
              <ADSignInForm dividerLabel={tAuth('ad_divider')} showDivider={false} />
            </TabsContent>
          ) : null}
        </Tabs>
      ) : (
        emailForm
      )}

      {signupFooter}
    </div>
  );
}
