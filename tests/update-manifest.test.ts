import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  releaseNotes,
  signManifest,
  updateKind,
  verifyManifest,
  type UpdateManifest,
} from '../desktop/update-manifest';
import { UPDATE_PUBLIC_KEY } from '../desktop/update-public-key';

const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    private: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    public: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
};
const manifest: UpdateManifest = {
  version: '0.2.0',
  publishedAt: '2026-11-03T12:00:00Z',
  notes: '### Added\n- Updates',
  notesUrl: 'https://github.com/free-solo-lab/free-solo-reviewer/releases/tag/v0.2.0',
  assets: [
    {
      arch: 'arm64',
      url: 'https://github.com/free-solo-lab/free-solo-reviewer/releases/download/v0.2.0/Reviewer-0.2.0-darwin-arm64.zip',
      sha256: 'a'.repeat(64),
      size: 10,
    },
  ],
};

describe('signed update manifest', () => {
  it('accepts a manifest signed by the release key and nothing else', () => {
    const key = keys();
    const signed = signManifest(manifest, key.private);
    expect(verifyManifest(signed, key.public)).toEqual(manifest);
    // A manifest edited after signing, e.g. pointing at another archive, is rejected.
    const edited = {
      ...signed,
      manifest: signed.manifest.replace('a'.repeat(64), 'b'.repeat(64)),
    };
    expect(() => verifyManifest(edited, key.public)).toThrow('не подписано');
    expect(() => verifyManifest(signed, keys().public)).toThrow('не подписано');
    expect(() => verifyManifest({ manifest: '{}' }, key.public)).toThrow();
  });
  it('ships a valid Ed25519 public key', () => {
    expect(createPublicKey(UPDATE_PUBLIC_KEY).asymmetricKeyType).toBe('ed25519');
  });
});

describe('versions', () => {
  it('orders releases and prereleases', () => {
    expect(compareVersions('0.2.0', '0.1.3')).toBe(1);
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('0.1.3', '0.1.3')).toBe(0);
    expect(compareVersions('0.2.0-alpha.1', '0.2.0')).toBe(-1);
    expect(compareVersions('0.2.0', '0.2.0-alpha.1')).toBe(1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
  });
  it('backs up data only before releases that may change it', () => {
    expect(updateKind('0.1.3', '0.1.4')).toBe('patch');
    expect(updateKind('0.1.3', '0.2.0')).toBe('minor');
    expect(updateKind('0.9.0', '1.0.0')).toBe('major');
  });
  it('takes the release notes of one version from the changelog', () => {
    const notes = releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), '0.1.2');
    expect(notes).toContain('### Fixed');
    expect(notes).not.toContain('## [0.1.1]');
    expect(releaseNotes('# Changelog', '9.9.9')).toBe('');
  });
});
