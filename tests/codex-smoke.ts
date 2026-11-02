// Explicit integration smoke: contacts the user's configured Codex provider.
import { fixture } from './fixtures.js';
import { createSnapshot } from '../server/repository.js';
import { indexSnapshot } from '../server/indexer.js';
import { CodexProvider } from '../server/provider.js';
import { validateModelResult } from '../server/validation.js';
import { join } from 'node:path';
const f = await fixture();
try {
  const snapshot = await createSnapshot(f.repo, 12, join(f.root, 'snapshots'), f.github);
  const indexes = [await indexSnapshot(snapshot, 'base'), await indexSnapshot(snapshot, 'head')];
  const result = await new CodexProvider().analyze(
    { snapshots: [snapshot], indexes },
    AbortSignal.timeout(180_000),
    console.log,
  );
  const checked = await validateModelResult(result, [snapshot]);
  console.log(
    JSON.stringify({
      ok: true,
      findings: checked.findings.length,
      scenarios: checked.scenarios.length,
      transactions: checked.transactions.length,
      gaps: checked.gaps.length,
    }),
  );
} finally {
  await f.cleanup();
}
