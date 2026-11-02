import { getLanguage, t } from './i18n.js';
/** Present older plain prose as Markdown without changing persisted model claims. */
export function reviewDescription(
  text: string,
  kind: 'overview' | 'scenario' = 'overview',
): string {
  if (!text.trim() || /(^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```)|\*\*|`|\]\()/m.test(text))
    return text;
  const sentences = [
    ...new Intl.Segmenter(getLanguage(), { granularity: 'sentence' }).segment(text),
  ]
    .map((s) => s.segment.trim())
    .filter(Boolean);
  const code = (value: string) =>
    value.replace(/\b(?:[A-Za-z]\w*_[\w]+|[A-Za-z][a-z\d]+[A-Z][\w]*)\b/g, (name) => `\`${name}\``);
  if (sentences.length < 2) return code(text);
  return `### ${kind === 'overview' ? t('Key points') : t('What happens')}\n\n${code(sentences[0])}\n\n### ${kind === 'overview' ? t('Change details') : t('Important details')}\n\n${sentences
    .slice(1)
    .map((s) => `- ${code(s)}`)
    .join('\n')}`;
}

/** Drops whole `### Title` sections that the interface no longer shows in saved descriptions. */
export function omitSections(markdown: string, titles: string[]): string {
  const hidden = new Set(titles.map((title) => title.toLowerCase()));
  let skipping = false;
  return markdown
    .split('\n')
    .filter((line) => {
      const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
      if (heading) skipping = hidden.has(heading[1].toLowerCase());
      return !skipping;
    })
    .join('\n')
    .trim();
}
