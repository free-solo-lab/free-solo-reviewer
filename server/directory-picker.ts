import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { AppError } from './process.js';

interface PickerResult {
  stdout: string;
  stderr?: string;
  code: string | number | null;
}
type PickerRunner = (binary: string, args: string[]) => Promise<PickerResult>;
const run: PickerRunner = (binary, args) =>
  new Promise((resolve) => {
    execFile(
      binary,
      args,
      { encoding: 'utf8', timeout: 300_000, maxBuffer: 16_384 },
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, code: error ? (error.code ?? null) : 0 });
      },
    );
  });

/** A native dialog supplies a local path; it does not upload or traverse folder contents. */
export async function pickDirectory(
  options: { platform?: NodeJS.Platform; run?: PickerRunner } = {},
): Promise<string | null> {
  const execute = options.run ?? run;
  const platform = options.platform ?? process.platform;
  let result: PickerResult;
  if (platform === 'darwin') {
    result = await execute('osascript', [
      '-e',
      `
try
  set selectedFolder to choose folder with prompt "Выберите локальный Git-репозиторий"
  return POSIX path of selectedFolder
on error errorMessage number errorNumber
  if errorNumber is -128 then return ""
  error errorMessage number errorNumber
end try`,
    ]);
  } else if (platform === 'win32') {
    result = await execute('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-Command',
      `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$picker = New-Object System.Windows.Forms.FolderBrowserDialog
$picker.Description = 'Выберите локальный Git-репозиторий'
$picker.ShowNewFolderButton = $false
try {
  if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($picker.SelectedPath) }
} finally { $picker.Dispose() }`,
    ]);
  } else if (platform === 'linux') {
    result = await execute('zenity', [
      '--file-selection',
      '--directory',
      '--title=Выберите локальный Git-репозиторий',
    ]);
    if (result.code === 1 && !result.stdout && !result.stderr) return null;
  } else {
    throw new AppError('Системный выбор папки недоступен. Укажите путь вручную.', 501);
  }
  if (result.code !== 0)
    throw new AppError(
      'Не удалось открыть системное окно выбора папки. Укажите путь вручную.',
      503,
    );
  const path = result.stdout.replace(/\r?\n$/, '');
  if (!path) return null;
  if (!isAbsolute(path) || !(await stat(path).catch(() => null))?.isDirectory()) {
    throw new AppError('Выбранный каталог недоступен. Выберите папку ещё раз.');
  }
  return path;
}
