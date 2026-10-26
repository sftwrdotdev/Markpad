import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { KeyCode } from 'monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js';
import { KeyMod } from 'monaco-editor/esm/vs/editor/common/services/editorBaseApi.js';

import { editorActions, type EditorActionDeps } from '../src/lib/utils/editorActions.js';
import { getSupportedLanguages, type LanguageCode, t, type Translation } from '../src/lib/utils/i18n.js';
import { translations } from './allTranslations.js';
import { bareCommands, chordOf, editorKeymap, PLATFORMS, registeredActions } from './keymapHarness.js';

// The editor's context-menu / command-palette actions, as `utils/editorActions.ts`
// declares them: labels per UI language, ids, and what the toggles write.

const supported = getSupportedLanguages().map((l) => l.code as LanguageCode);

/** The actions labelled in `lang`, with every dependency a no-op. */
function actionsIn(lang: LanguageCode) {
	const deps = new Proxy({ monaco: { KeyMod, KeyCode }, isMac: false, settings: {} } as Record<string, unknown>, {
		get: (target, key) => (typeof key === 'string' && key in target ? target[key] : () => undefined),
	}) as unknown as EditorActionDeps;
	return editorActions(deps, lang);
}

/**
 * Does `lang`'s own dictionary define `key`, without the English fallback?
 *
 * `t()` falls back to English, so comparing against `t(key, lang)` alone cannot
 * see a locale that lost its entry.
 */
function defines(lang: LanguageCode, key: string): boolean {
	let node: string | Translation | undefined = translations[lang];
	for (const part of key.split('.')) {
		if (typeof node !== 'object' || node === null || !(part in node)) return false;
		node = node[part];
	}
	return typeof node === 'string';
}

describe('context menu actions', () => {
	// The markdown formatting entries that used to be English string literals.
	const FORMATTING_ACTIONS: ReadonlyArray<[actionId: string, key: string]> = [
		['fmt-strikethrough', 'menu.strikethrough'],
		['fmt-inline-code', 'menu.inlineCode'],
		['fmt-code-block', 'menu.codeBlock'],
		['fmt-quote', 'menu.quote'],
		['fmt-heading-1', 'menu.heading1'],
		['fmt-heading-2', 'menu.heading2'],
		['fmt-heading-3', 'menu.heading3'],
		['fmt-bullet-list', 'menu.bulletList'],
		['fmt-numbered-list', 'menu.numberedList'],
		['fmt-checklist', 'menu.checklist'],
		['fmt-link', 'menu.link'],
	];

	test('every context-menu label is translated, none is an English literal', () => {
		for (const [actionId, key] of FORMATTING_ACTIONS) {
			let differsFromEnglish = false;
			for (const lang of supported) {
				const label = actionsIn(lang).find((action) => action.id === actionId)?.label;
				assert.equal(label, t(key, lang), `${actionId} in ${lang} takes its label from ${key}`);
				if (label !== t(key, 'en')) differsFromEnglish = true;
			}
			// Not vacuous: some language reads it differently, so an English literal
			// would fail the loop above.
			assert.ok(differsFromEnglish, `${key} reads the same in every language, so this proves nothing`);
		}
	});

	test('toggle-occurrences-highlight has its own label, not Show Whitespace', () => {
		// The two actions shared `settings.showWhitespace`, so the context menu
		// listed the same entry twice and one of them silently toggled the other
		// setting.
		for (const lang of supported) {
			const actions = actionsIn(lang);
			const occurrences = actions.find((action) => action.id === 'toggle-occurrences-highlight')?.label;
			const whitespace = actions.find((action) => action.id === 'toggle-whitespace')?.label;
			assert.ok(defines(lang, 'settings.occurrencesHighlight'), `translated for ${lang}`);
			assert.ok(defines(lang, 'settings.showWhitespace'), `translated for ${lang}`);
			assert.equal(occurrences, t('settings.occurrencesHighlight', lang));
			assert.equal(whitespace, t('settings.showWhitespace', lang));
			assert.notEqual(occurrences, whitespace, `the two context-menu entries are distinguishable in ${lang}`);
		}

		const settings = { showWhitespace: false, occurrencesHighlight: false };
		const deps = new Proxy({ monaco: { KeyMod, KeyCode }, isMac: false, settings } as Record<string, unknown>, {
			get: (target, key) => (typeof key === 'string' && key in target ? target[key] : () => undefined),
		}) as unknown as EditorActionDeps;
		const actions = editorActions(deps, 'en');
		actions.find((action) => action.id === 'toggle-occurrences-highlight')?.run(null as never);
		assert.deepEqual(settings, { showWhitespace: false, occurrencesHighlight: true }, 'Highlight Occurrences toggles its own setting');
		actions.find((action) => action.id === 'toggle-whitespace')?.run(null as never);
		assert.deepEqual(settings, { showWhitespace: true, occurrencesHighlight: true }, 'Show Whitespace toggles its own setting');
	});

	test('no two actions share a label within a language', () => {
		// A duplicated label is indistinguishable from a duplicated menu entry from
		// the user's side, which is exactly how ED-6 presented.
		for (const lang of supported) {
			const seen = new Map<string, string>();
			const actions = actionsIn(lang);
			assert.ok(actions.length > 30, 'the localized action set was found');
			for (const { id, label } of actions) {
				const previous = seen.get(label);
				assert.equal(previous, undefined, `${lang}: "${label}" is used by both ${previous} and ${id}`);
				seen.set(label, id);
			}
		}
	});

	test('no action id is registered more than once', () => {
		const ids = actionsIn('en').map((action) => action.id);
		assert.ok(ids.length > 30, 'the action set was found');
		assert.equal(new Set(ids).size, ids.length, 'action ids are unique');
	});
});

describe('AltGr guard', () => {
	test('every Ctrl+Alt action refuses a keystroke that is really AltGr', () => {
		// Windows sends AltGr as Ctrl+Alt, so on a Polish layout AltGr+Z (ż) is also
		// Ctrl+Alt+Z, Zen mode's chord. The editor sets `altGraphChord` on its own
		// keydown (editor.checks.spec.ts); every Ctrl+Alt action has to check it.
		const ctrlAlt = KeyMod.CtrlCmd | KeyMod.Alt;
		const { actions } = registeredActions(false);
		const guarded = actions.filter((action) =>
			action.keybindings?.some((binding) => (binding & ctrlAlt) === ctrlAlt),
		);
		// Zen mode and Insert Table today. Empty would make the loop below vacuous.
		assert.ok(guarded.length >= 2, `found ${guarded.length} Ctrl+Alt actions`);
		for (const action of guarded) assert.equal(action.keybindingContext, '!altGraphChord', action.id);
	});
});

describe('editor option wiring', () => {
	test('tab cycling avoids Cmd+Tab, which macOS never delivers to the app', () => {
		// Reference frame: VS Code binds Ctrl+Tab / Ctrl+Shift+Tab with
		// KeyMod.WinCtrl on macOS precisely because Cmd+Tab belongs to the system
		// application switcher.
		for (const platform of PLATFORMS) {
			const keymap = editorKeymap(platform.mac, platform.os);
			assert.deepEqual(keymap.get('tab-next'), ['Ctrl+Tab'], `tab-next on ${platform.name}`);
			assert.deepEqual(keymap.get('tab-prev'), ['Ctrl+Shift+Tab'], `tab-prev on ${platform.name}`);
		}
	});

	test('Ctrl+S is registered exactly once, by the command-palette action', () => {
		for (const platform of PLATFORMS) {
			const save = platform.mac ? 'Meta+S' : 'Ctrl+S';
			const owners = [
				...[...editorKeymap(platform.mac, platform.os)].filter(([, chords]) => chords.includes(save)).map(([id]) => id),
				...bareCommands().filter((command) => chordOf(command.binding, platform.os) === save).map((command) => command.handler),
			];
			assert.deepEqual(owners, ['file-save'], `${platform.name}: ${save} has one binding, the palette action`);
		}
		const { actions, calls } = registeredActions(false);
		actions.find((action) => action.id === 'file-save')?.run();
		assert.deepEqual(calls, ['oncommand("save")']);
	});
});
