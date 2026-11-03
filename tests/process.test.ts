import { expect, it } from 'vitest';
import { command, CommandError } from '../server/process';

it('preserves termination diagnostics for a real timeout with no command output', async () => {
  const error = await command(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
    timeout: 200,
  }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(CommandError);
  expect(error).toMatchObject({
    status: 502,
    code: undefined,
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: 'SIGTERM',
    killed: true,
    timeoutMs: 200,
  });
  expect((error as CommandError).durationMs).toBeGreaterThanOrEqual(150);
});

it('distinguishes a nonzero exit with empty stderr from forced termination', async () => {
  const error = await command(process.execPath, ['-e', 'process.exit(7)']).catch(
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(CommandError);
  expect(error).toMatchObject({
    status: 502,
    code: undefined,
    stdout: '',
    stderr: '',
    exitCode: 7,
    signal: null,
    killed: false,
    timeoutMs: 60_000,
  });
  expect((error as CommandError).durationMs).toBeGreaterThanOrEqual(0);
});

it('keeps command output and the original stderr-based message', async () => {
  const error = await command(process.execPath, [
    '-e',
    "process.stdout.write('output'); process.stderr.write('failure'); process.exit(2)",
  ]).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(CommandError);
  expect(error).toMatchObject({
    message: `${process.execPath}: failure`,
    stdout: 'output',
    stderr: 'failure',
    exitCode: 2,
    killed: false,
  });
});
