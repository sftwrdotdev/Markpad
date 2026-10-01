import { getSupportedLanguages, loadLocale, type LanguageCode, type Translation } from '../src/lib/utils/i18n.js';

// Only English is bundled into i18n.ts; the app fetches the rest on first use.
// Tests that walk every language load them all up front, which also makes
// `t(key, lang)` answer in that language rather than in English.
export const translations = Object.fromEntries(
	await Promise.all(getSupportedLanguages().map(async ({ code }) => [code, await loadLocale(code)])),
) as Record<LanguageCode, Translation>;
