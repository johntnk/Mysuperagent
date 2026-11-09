import { beforeEach, afterEach, vi } from 'vitest';
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('REAL_NETWORK_FORBIDDEN_IN_OFFLINE_TEST');
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
