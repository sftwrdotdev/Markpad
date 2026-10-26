import type { settings as Settings } from '../stores/settings.svelte.js';
import type { Tab, tabManager as TabManager } from '../stores/tabs.svelte.js';
import { parseFrontMatterEditableValue, type FrontMatterField } from '../utils/frontMatter.js';
import type { LanguageCode, TranslationKey } from '../utils/i18n.js';

export type FrontMatterEditOptions = {
	tabManager: typeof TabManager;
	settings: typeof Settings;
	documentSession: { ensureFullContent: (tabId: string) => Promise<boolean> };
	addToast: (message: string, type?: 'info' | 'error' | 'warning') => unknown;
	t: (key: TranslationKey, language: LanguageCode) => string;
	/** Rewrites the field in the tab's buffer and re-renders; `nextValue` may throw. */
	applyFrontMatter: (tab: Tab, field: FrontMatterField, nextValue: () => unknown) => Promise<void>;
};

/** The front matter panel's edits, made from reading mode. */
export function createFrontMatterEdit(o: FrontMatterEditOptions) {
	const { tabManager, settings, documentSession, addToast, t, applyFrontMatter } = o;

	async function handleFrontMatterEdit(field: FrontMatterField, value: string) {
		const tab = tabManager.activeTab;
		if (!tab) return;
		// Front matter is editable from reading mode, which a large file can
		// reach while its buffer is still the preview slice. Rewriting that
		// slice and saving it would drop the rest of the document.
		if (!(await documentSession.ensureFullContent(tab.id))) {
			addToast(t('toast.partialDocument', settings.language), 'error');
			return;
		}
		await applyFrontMatter(tab, field, () => parseFrontMatterEditableValue(field, value));
	}

	async function handleFrontMatterListChange(field: FrontMatterField, nextItems: string[]) {
		const tab = tabManager.activeTab;
		if (!tab) return;
		// Same partial-buffer guard as handleFrontMatterEdit.
		if (!(await documentSession.ensureFullContent(tab.id))) {
			addToast(t('toast.partialDocument', settings.language), 'error');
			return;
		}
		await applyFrontMatter(tab, field, () => nextItems);
	}

	return { handleFrontMatterEdit, handleFrontMatterListChange };
}
