/** Present older plain prose as Markdown without changing persisted model claims. */
export function reviewDescription(
  text: string,
  kind: 'overview' | 'scenario' = 'overview',
): string {
  if (!text.trim() || /(^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```)|\*\*|`|\]\()/m.test(text))
    return text;
  const sentences = [...new Intl.Segmenter('ru', { granularity: 'sentence' }).segment(text)]
    .map((s) => s.segment.trim())
    .filter(Boolean);
  const code = (value: string) =>
    value.replace(/\b(?:[A-Za-z]\w*_[\w]+|[A-Za-z][a-z\d]+[A-Z][\w]*)\b/g, (name) => `\`${name}\``);
  if (sentences.length < 2) return code(text);
  return `### ${kind === 'overview' ? 'Главное' : 'Что происходит'}\n\n${code(sentences[0])}\n\n### ${kind === 'overview' ? 'Детали изменений' : 'Важные детали'}\n\n${sentences
    .slice(1)
    .map((s) => `- ${code(s)}`)
    .join('\n')}`;
}
