import type { Options } from '@electron/packager';
import { command } from '../server/process.js';

/** Seal the complete bundle without requiring an Apple Developer identity. */
export const macSigning: Exclude<Options['osxSign'], boolean | undefined> = {
  identity: '-',
  identityValidation: false,
  continueOnError: false,
  preAutoEntitlements: false,
  preEmbedProvisioningProfile: false,
  optionsForFile: () => ({
    hardenedRuntime: false,
    timestamp: 'none',
    entitlements: ['com.apple.security.cs.allow-jit'],
  }),
};

export async function verifyApplicationSignature(appPath: string) {
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
    timeout: 300000,
  });
}
