import { afterEach, describe, expect, it } from 'vitest';
import { plural, setLanguage } from '../shared/i18n';

afterEach(() => setLanguage('ru'));
describe('plural forms', () => {
  it('matches the Russian noun to the count, including the teens', () => {
    const files = (n: number) => plural(n, 'changed file', 'changed files');
    expect([1, 2, 5, 11, 12, 14, 21, 22, 25, 111, 101].map(files)).toEqual([
      '1 изменённый файл',
      '2 изменённых файла',
      '5 изменённых файлов',
      '11 изменённых файлов',
      '12 изменённых файлов',
      '14 изменённых файлов',
      '21 изменённый файл',
      '22 изменённых файла',
      '25 изменённых файлов',
      '111 изменённых файлов',
      '101 изменённый файл',
    ]);
  });
  it('uses one and other in English', () => {
    setLanguage('en');
    expect([1, 2, 21].map((n) => plural(n, 'changed file', 'changed files'))).toEqual([
      '1 changed file',
      '2 changed files',
      '21 changed files',
    ]);
  });
});
