import { ru } from './locales/ru.js';

/**
 * Interface languages. English is the source language: messages are written in English in the
 * code and looked up in a catalog for other languages, falling back to English.
 */
export const LANGUAGES = ['en', 'ru'] as const;
export type Language = (typeof LANGUAGES)[number];
/** How each language names itself in the language picker. */
export const languageLabels: Record<Language, string> = { en: 'English', ru: 'Русский' };
/** The language name given to the model, so that its prose matches the interface. */
export const languageNames: Record<Language, string> = { en: 'English', ru: 'Russian' };
export const isLanguage = (value: unknown): value is Language =>
  (LANGUAGES as readonly unknown[]).includes(value);

const catalogs: Record<Language, Record<string, string>> = { en: {}, ru };
let current: Language = 'en';
export const getLanguage = () => current;
export const setLanguage = (language: Language) => {
  current = language;
};
/** The language of a locale such as "ru-RU"; anything unsupported is English. */
export function languageOf(locale: string | undefined): Language {
  const code = locale?.toLowerCase().split(/[-_.]/)[0];
  return isLanguage(code) ? code : 'en';
}

const CONTEXT = '\u0004';
const format = (template: string, args: unknown[]) =>
  args.length
    ? template.replace(/\{(\d+)\}/g, (match, index: string) =>
        +index < args.length ? String(args[+index]) : match,
      )
    : template;
/** A message in the current language; `{0}`, `{1}`… are replaced by the arguments. */
export function t(text: string, ...args: unknown[]): string {
  return format(catalogs[current][text] ?? text, args);
}
/** Like `t`, for an English text that needs different translations in different places. */
export function tc(context: string, text: string, ...args: unknown[]): string {
  return format(catalogs[current][`${context}${CONTEXT}${text}`] ?? text, args);
}
/** The message in every language, to recognize text saved while another language was on. */
export const inAllLanguages = (text: string) => [
  ...new Set(LANGUAGES.map((language) => catalogs[language][text] ?? text)),
];

/** "1 file", "5 files"; the catalog keeps a language's own forms under "one|other". */
export function plural(count: number, one: string, other: string) {
  const forms = catalogs[current][`${one}|${other}`]?.split('|');
  if (!forms) return `${count} ${count === 1 ? one : other}`;
  if (current !== 'ru' || forms.length < 3) return `${count} ${count === 1 ? forms[0] : forms[1]}`;
  const mod10 = count % 10,
    mod100 = count % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? forms[0]
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? forms[1]
        : forms[2];
  return `${count} ${word}`;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The fixed start of a message in every language: the text before its first placeholder. */
const prefixes = (message: string) => inAllLanguages(message).map((m) => m.split(/\{\d+\}/)[0]);
/** Whether text starts like the message in any language, saved earlier or now. */
export const startsLike = (text: string, message: string) =>
  prefixes(message).some((prefix) => text.startsWith(prefix));
/** A pattern matching the start of the message in any language. */
export const prefixPattern = (message: string) =>
  `(?:${prefixes(message).map(escapeRegExp).join('|')})`;
