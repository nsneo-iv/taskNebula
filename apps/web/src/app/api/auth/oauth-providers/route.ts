import { NextResponse } from 'next/server';
import {
  getLoginOAuthAvailability,
  getLoginOAuthCredentials,
  type LoginOAuthAvailability,
} from '@/lib/auth/login-oauth-providers';
import { isAdAuthEnabled } from '@/lib/auth/ad-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  let providers: LoginOAuthAvailability = { github: false, google: false, oidc: false };
  let oidcName: string | null = null;

  try {
    providers = await getLoginOAuthAvailability();
    const oidcCredentials = (await getLoginOAuthCredentials()).oidc;
    oidcName = oidcCredentials && 'issuer' in oidcCredentials ? oidcCredentials.name : null;
  } catch (error) {
    console.error('[auth/oauth-providers] failed to resolve login providers', error);
  }

  return NextResponse.json(
    { providers, oidcName, ad: isAdAuthEnabled() },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );
}