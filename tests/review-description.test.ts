import { describe, it, expect } from 'vitest';
import { reviewDescription } from '../shared/review-description';
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
