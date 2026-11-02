import { expect, it, vi } from 'vitest';
import { githubRemoteSlug } from '../server/github';

it.each(['git@work-alias:team/backoffice.git', 'ssh://git@work-alias/team/backoffice.git'])(
  'resolves a GitHub SSH alias from local configuration: %s',
  async (remote) => {
    const config = vi.fn(async () => 'host work-alias\nhostname github.com\nuser git\n');
    expect(await githubRemoteSlug(remote, config)).toBe('team/backoffice');
    expect(config).toHaveBeenCalledExactlyOnceWith('work-alias');
  },
);
it('does not mistake another Git server for GitHub', async () => {
  await expect(
    githubRemoteSlug('git@work-alias:team/repo.git', async () => 'hostname gitlab.com\n'),
  ).rejects.toThrow('не указывает');
  const config = vi.fn();
  await expect(githubRemoteSlug('/local/repo.git', config)).rejects.toThrow();
  await expect(githubRemoteSlug('git@-bad:team/repo.git', config)).rejects.toThrow();
  expect(config).not.toHaveBeenCalled();
});
it('recognizes a direct GitHub remote without loading SSH configuration', async () => {
  const config = vi.fn();
  expect(await githubRemoteSlug('https://github.com/team/repo.git', config)).toBe('team/repo');
  expect(config).not.toHaveBeenCalled();
});
