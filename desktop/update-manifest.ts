import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { z } from 'zod';
import { t } from '../shared/i18n.js';

/** Where the app looks for a newer release; GitHub redirects it to the latest one. */
export const UPDATE_MANIFEST_URL =
  'https://github.com/free-solo-lab/free-solo-reviewer/releases/latest/download/latest.json';
/** Release pages, for installing by hand when the app cannot replace itself. */
export const RELEASES_URL = 'https://github.com/free-solo-lab/free-solo-reviewer/releases';
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export const updateManifestSchema = z.object({
  version: z.string().regex(VERSION),
  publishedAt: z.string(),
  notes: z.string().max(20_000),
  notesUrl: z.string().url(),
  assets: z
    .array(
      z.object({
        arch: z.enum(['arm64', 'x64']),
        url: z.string().url(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        size: z.number().int().positive(),
      }),
    )
    .min(1),
});
export type UpdateManifest = z.infer<typeof updateManifestSchema>;
/** The manifest text exactly as signed, so verifying never depends on JSON formatting. */
export interface SignedManifest {
  manifest: string;
  signature: string;
}

export function signManifest(manifest: UpdateManifest, privateKeyPem: string): SignedManifest {
  const text = JSON.stringify(updateManifestSchema.parse(manifest));
  const signature = sign(null, Buffer.from(text), createPrivateKey(privateKeyPem));
  return { manifest: text, signature: signature.toString('base64') };
}

/** Throws unless the release key signed this manifest. */
export function verifyManifest(signed: unknown, publicKeyPem: string): UpdateManifest {
  const envelope = z.object({ manifest: z.string(), signature: z.string() }).parse(signed);
  const valid = verify(
    null,
    Buffer.from(envelope.manifest),
    createPublicKey(publicKeyPem),
    Buffer.from(envelope.signature, 'base64'),
  );
  if (!valid) throw new Error(t('The update manifest is not signed by the release key.'));
  return updateManifestSchema.parse(JSON.parse(envelope.manifest));
}

const parts = (version: string) => {
  const [core, pre] = version.split('-', 2);
  return { numbers: core.split('.').map(Number), pre };
};
/** Semantic version order; a prerelease comes before its release. */
export function compareVersions(a: string, b: string) {
  const left = parts(a),
    right = parts(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** A patch only fixes problems; a minor or major release may change data, so it is backed up. */
export function updateKind(current: string, next: string): 'patch' | 'minor' | 'major' {
  const from = parts(current).numbers,
    to = parts(next).numbers;
  return to[0] !== from[0] ? 'major' : to[1] !== from[1] ? 'minor' : 'patch';
}

export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** The CHANGELOG section of one version, without its heading. */
export function releaseNotes(changelog: string, version: string) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start < 0) return '';
  const end = lines.findIndex((line, i) => i > start && /^## \[|^\[[^\]]+\]: /.test(line));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
}
