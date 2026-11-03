/**
 * Writes the signed latest.json for a GitHub release from its update archives:
 *   REVIEWER_UPDATE_KEY=<pem> node --import tsx desktop/release-manifest.ts --dir <assets> \
 *     [--notes <notes.md>]
 * The archives are Reviewer-<version>-darwin-<arch>.zip, as `npm run desktop:dmg` builds them;
 * --notes also writes the CHANGELOG section of the version for the release page.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { releaseNotes, sha256, signManifest, type UpdateManifest } from './update-manifest.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({
  options: { dir: { type: 'string' }, version: { type: 'string' }, notes: { type: 'string' } },
});
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version: string = values.version ?? metadata.version;
const dir = resolve(values.dir ?? join(root, 'release'));
const key = process.env.REVIEWER_UPDATE_KEY;
if (!key) throw new Error('REVIEWER_UPDATE_KEY is not set.');

const tag = `v${version}`;
const download = `https://github.com/free-solo-lab/free-solo-reviewer/releases/download/${tag}`;
const assets: UpdateManifest['assets'] = [];
for (const arch of ['arm64', 'x64'] as const) {
  const name = `Reviewer-${version}-darwin-${arch}.zip`;
  if (!(await readdir(dir)).includes(name)) continue;
  const data = await readFile(join(dir, name));
  assets.push({ arch, url: `${download}/${name}`, sha256: sha256(data), size: data.length });
}
if (!assets.length) throw new Error(`No update archives for ${version} in ${dir}.`);
const notes = releaseNotes(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), version);
if (!notes) throw new Error(`CHANGELOG.md has no section for ${version}.`);
if (values.notes) await writeFile(resolve(values.notes), `${notes}\n`);
const signed = signManifest(
  {
    version,
    publishedAt: new Date().toISOString(),
    notes,
    notesUrl: `https://github.com/free-solo-lab/free-solo-reviewer/releases/tag/${tag}`,
    assets,
  },
  key,
);
await writeFile(join(dir, 'latest.json'), `${JSON.stringify(signed, null, 2)}\n`);
console.log(`latest.json: ${version}, ${assets.map((a) => a.arch).join(', ')}`);
