import type * as Monaco from 'monaco-editor';
import type { LanguageCode } from './i18n.js';

export type LocalizedActionsDeps = {
	/** The UI language; read first, so the effect tracks it before the editor exists. */
	language: () => LanguageCode;
	/** The component's `editorReady`. */
	ready: () => boolean;
	editor: () => Pick<Monaco.editor.IStandaloneCodeEditor, 'addAction'>;
	/** Every action whose label comes from `t()`, in `lang`. */
	descriptors: (lang: LanguageCode) => Monaco.editor.IActionDescriptor[];
};

/**
 * A Monaco action captures its label when it is registered, so actions built
 * once at mount keep whatever language they were built with — switching the
 * UI language used to leave the editor's context menu in the old one until
 * the app was restarted. `addAction` returns an `IDisposable` for exactly
 * this case: the registration below is re-run on every language change, and
 * the previous disposables are released first so ids are never registered
 * twice (a duplicate id leaves a duplicate context-menu entry behind).
 *
 * Call during component init. Returns the release, for `onDestroy`.
 */
export function localizedEditorActions(deps: LocalizedActionsDeps): () => void {
	let localizedActions: Monaco.IDisposable[] = [];

	function disposeLocalizedActions() {
		for (const action of localizedActions) action.dispose();
		localizedActions = [];
	}

	function registerLocalizedActions(lang: LanguageCode) {
		// Belt and braces: Svelte runs the effect cleanup before a re-run, but
		// re-registering an id without disposing the old action would leave a
		// duplicate entry in the context menu, so never assume it happened.
		disposeLocalizedActions();
		localizedActions = deps.descriptors(lang).map((descriptor) => deps.editor().addAction(descriptor));
	}

	$effect(() => {
		const lang = deps.language();
		if (!deps.ready()) return;

		registerLocalizedActions(lang);
		return disposeLocalizedActions;
	});

	return disposeLocalizedActions;
}
