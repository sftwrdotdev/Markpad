import { t, type LanguageCode } from './i18n.js';

/** One row of `list_viewer_windows`. */
export type ViewerWindowEntry = {
	label: string;
	number: number;
	tag_name: string | null;
	active_tab_title: string;
	tab_count: number;
};

export function windowDisplay(window: ViewerWindowEntry, lang: LanguageCode): string {
	const identity = window.tag_name ?? `${t('menu.window', lang)} ${window.number}`;
	return window.active_tab_title ? `${identity} · ${window.active_tab_title}` : identity;
}
