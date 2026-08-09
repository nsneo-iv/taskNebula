const getLoginOAuthAvailabilityMock = jest.fn();
const isAdAuthEnabledMock = jest.fn();

jest.mock('next/server', () => {
  class MockNextResponse {
    readonly headers: Headers;
    readonly status: number;

    constructor(
      private readonly payload: unknown,
      init?: { status?: number; headers?: HeadersInit }
    ) {
      this.status = init?.status || 200;
      this.headers = new Headers(init?.headers);
    }

    async json() {
      return this.payload;
    }

    static json(payload: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(payload, init);
    }
  }

  return {
    NextResponse: MockNextResponse,
  };
});

jest.mock('@/lib/auth/login-oauth-providers', () => ({
  getLoginOAuthAvailability: (...args: unknown[]) => getLoginOAuthAvailabilityMock(...args),
}));

jest.mock('@/lib/auth/ad-auth', () => ({
  isAdAuthEnabled: () => isAdAuthEnabledMock(),
}));

import { GET } from './route';

describe('/api/auth/oauth-providers route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isAdAuthEnabledMock.mockReturnValue(false);
  });

  it('returns public OAuth login provider availability without caching', async () => {
    getLoginOAuthAvailabilityMock.mockResolvedValue({
      github: true,
      google: false,
    });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      providers: {
        github: true,
        google: false,
      },
      ad: false,
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('exposes the AD availability flag for the login screen', async () => {
    getLoginOAuthAvailabilityMock.mockResolvedValue({
      github: false,
      google: false,
    });
    isAdAuthEnabledMock.mockReturnValue(true);

    const response = await GET();

    await expect(response.json()).resolves.toEqual({
      providers: {
        github: false,
        google: false,
      },
      ad: true,
    });
  });

  it('fails closed when provider resolution throws', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    getLoginOAuthAvailabilityMock.mockRejectedValue(new Error('database unavailable'));

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      providers: {
        github: false,
        google: false,
      },
      ad: false,
    });

    consoleSpy.mockRestore();
  });
});