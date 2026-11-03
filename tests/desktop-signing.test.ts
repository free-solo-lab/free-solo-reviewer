import { afterEach, expect, it, vi } from 'vitest';
import { command } from '../server/process';
import { macSigning, verifyApplicationSignature } from '../desktop/signing';

vi.mock('../server/process', () => ({ command: vi.fn() }));
afterEach(() => vi.resetAllMocks());
it('requires signing success and limits ad-hoc entitlements to JIT', () => {
  expect(macSigning).toMatchObject({
    identity: '-',
    identityValidation: false,
    continueOnError: false,
  });
  expect(
    macSigning.optionsForFile?.('/app/Contents/MacOS/Reviewer', { platform: 'darwin' }),
  ).toEqual({
    hardenedRuntime: false,
    timestamp: 'none',
    entitlements: ['com.apple.security.cs.allow-jit'],
  });
});
it('rejects an invalid bundle before it can be packaged or launched', async () => {
  const error = new Error('invalid resource seal');
  vi.mocked(command).mockRejectedValue(error);
  await expect(verifyApplicationSignature('/app/Reviewer.app')).rejects.toBe(error);
  expect(command).toHaveBeenCalledWith(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', '/app/Reviewer.app'],
    { timeout: 300000 },
  );
});
