import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { buildDesktop } from './build.js';
import { command } from '../server/process.js';
const require = createRequire(import.meta.url);
const source = await buildDesktop();
let electron: string;
try {
  electron = require('electron');
} catch {
  await command(process.execPath, [require.resolve('electron/install.js')], { timeout: 300000 });
  electron = require('electron');
}
const child = spawn(electron, [source], {
  stdio: 'inherit',
  env: { ...process.env, REVIEW_WEB_DIR: join(source, 'ui') },
});
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
