import { describe, it, expect } from 'vitest';
import { omitSections, reviewDescription } from '../shared/review-description';
describe('saved plain-text description formatting', () => {
  it('structures old prose and marks code identifiers without inventing facts', () => {
    const result = reviewDescription(
      'PR добавляет RegisterOrder. Повтор по external_id возвращает ID. Код отправителя не представлен.',
      'scenario',
    );
    expect(result).toContain('### Что происходит');
    expect(result).toContain('PR добавляет `RegisterOrder`.');
    expect(result).toContain('- Повтор по `external_id` возвращает ID.');
    expect(result).toContain('- Код отправителя не представлен.');
  });
  it('preserves existing model Markdown exactly', () => {
    const text =
      '### Цель\n\n**Регистрация** через `RegisterOrder`.\n\n1. Проверить запрос.\n2. Записать документ.';
    expect(reviewDescription(text)).toBe(text);
  });
  it('keeps all sentences in their original order', () => {
    const text = 'Первая мысль. Вторая мысль. Третья мысль.';
    const result = reviewDescription(text);
    expect(result.indexOf('Первая')).toBeLessThan(result.indexOf('Вторая'));
    expect(result.indexOf('Вторая')).toBeLessThan(result.indexOf('Третья'));
  });
  it('does not add empty sections for empty or single-sentence text', () => {
    expect(reviewDescription('')).toBe('');
    expect(reviewDescription('Одно изменение.')).toBe('Одно изменение.');
  });
});

describe('hidden description sections', () => {
  it('drops a whole section up to the next heading and keeps the rest', () => {
    const text = [
      '### Суть изменений',
      'Поиск стал постраничным.',
      '### До и после',
      '- **До:** без курсора.',
      '- **После:** курсор.',
      '### Что требует проверки',
      '- Граница страницы.',
    ].join('\n');
    expect(omitSections(text, ['до и после'])).toBe(
      [
        '### Суть изменений',
        'Поиск стал постраничным.',
        '### Что требует проверки',
        '- Граница страницы.',
      ].join('\n'),
    );
    expect(omitSections(text, ['Ответы в обсуждении'])).toBe(text);
  });
});
