import { version } from '../package.json';

/** The release in package.json; the README explains what each part of the number means. */
export const APP_VERSION = version;
/** The changelog as it was tagged for this release. */
export const RELEASE_NOTES_URL = `https://github.com/free-solo-lab/free-solo-reviewer/blob/v${version}/CHANGELOG.md`;
