/**
 * Creates the Ed25519 key that signs update manifests. The private key goes to a file only its
 * owner can read and then into the REVIEWER_UPDATE_KEY secret of the repository; the public key
 * is printed for desktop/update-public-key.ts. A new key makes older apps reject new updates.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node --import tsx desktop/update-key.ts <private-key.pem>');
  process.exit(1);
}
const path = resolve(target);
if (existsSync(path)) {
  console.error(`${path} already exists; refusing to replace a signing key.`);
  process.exit(1);
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
await writeFile(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
console.log(publicKey.export({ type: 'spki', format: 'pem' }));
