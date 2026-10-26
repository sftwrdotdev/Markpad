import assert from 'node:assert/strict';
import { afterEach, describe, test, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => undefined }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: async () => undefined }));

import type * as Monaco from 'monaco-editor';
import { settings } from '../src/lib/stores/settings.svelte.js';
import { updatedEditorOptions } from '../src/lib/utils/editorOptions.js';
import { asRendererLine } from '../src/lib/utils/lineCoordinates.js';
import { mountEditor, type MountEditorDeps } from '../src/lib/utils/mountEditor.js';
import { TOKEN_TYPES } from '../src/lib/utils/semanticTokens.js';

/*
 * #799: the editor is created, then placed (view state, anchor line, the
 * preview's cursor, a pending Ctrl+E sync), then reports where it is. Monaco
 * keeps a placed scroll offset in pixels, so a font size or wrapping changed
 * after the placement moves every placed line; and a cursor put down before
 * the view state is restored, or after the editor has reported, carries the
 * stale position back to the preview.
 *
 * The Monaco double below keeps the options it was given and records the
 * layout in force whenever something is placed.
 */

type Layout = { fontSize: unknown; wrappingStrategy: unknown };
type Position = { lineNumber: number; column: number };

const FONT_INFO = 50;

function fakeMonaco(fontIsMonospace: boolean) {
	const placed: { what: string; layout: Layout }[] = [];
	const semanticProviders: { languageId: string; provider: Monaco.languages.DocumentSemanticTokensProvider; disposed: boolean }[] = [];
	let options: Record<string, unknown> = {};
	let position: Position = { lineNumber: 1, column: 1 };
	const layout = (): Layout => ({ fontSize: options.fontSize, wrappingStrategy: options.wrappingStrategy });
	const place = (what: string) => placed.push({ what, layout: layout() });
	const disposable = { dispose() {} };
	const keyDown: ((e: { browserEvent: KeyboardEvent }) => void)[] = [];
	const contextKeys = new Map<string, unknown>();

	const editor = {
		updateOptions: (next: Record<string, unknown>) => void (options = { ...options, ...next }),
		getOption: (id: number) => {
			assert.equal(id, FONT_INFO);
			return { isMonospace: fontIsMonospace };
		},
		restoreViewState: (state: { position: Position }) => {
			place('view state');
			position = state.position;
		},
		revealLineNearTop: () => place('anchor line'),
		getScrollHeight: () => 1000,
		getLayoutInfo: () => ({ height: 500 }),
		setScrollTop: () => place('scroll percentage'),
		setPosition: (next: Position) => void (position = next),
		getPosition: () => position,
		focus() {},
		onDidChangeModelContent: () => disposable,
		onDidChangeCursorPosition: () => disposable,
		onDidChangeCursorSelection: () => disposable,
		onDidChangeConfiguration: () => disposable,
		onKeyDown: (listener: (e: { browserEvent: KeyboardEvent }) => void) => {
			keyDown.push(listener);
			return disposable;
		},
		addCommand() {},
		createContextKey: (name: string, initial: unknown) => {
			contextKeys.set(name, initial);
			return { set: (value: unknown) => void contextKeys.set(name, value) };
		},
		getModel: () => null,
		dispose() {},
	};

	const register = () => disposable;
	const monaco = {
		editor: {
			create: (_container: HTMLElement, created: Record<string, unknown>) => {
				options = { ...created };
				return editor;
			},
			defineTheme() {},
			setTheme() {},
			EditorOption: { fontInfo: FONT_INFO },
			ScrollType: { Immediate: 1 },
		},
		languages: {
			registerDocumentSemanticTokensProvider: (
				languageId: string,
				provider: Monaco.languages.DocumentSemanticTokensProvider,
			) => {
				const entry = { languageId, provider, disposed: false };
				semanticProviders.push(entry);
				return { dispose: () => void (entry.disposed = true) };
			},
			registerDocumentSymbolProvider: register,
			registerFoldingRangeProvider: register,
			registerCompletionItemProvider: register,
			SymbolKind: { String: 14 },
		},
		KeyMod: { CtrlCmd: 2048, Shift: 1024 },
		KeyCode: { Enter: 3, Tab: 2, KeyV: 52, KeyX: 54 },
	};
	const pressKey = (init: KeyboardEventInit) => {
		const browserEvent = new KeyboardEvent('keydown', init);
		for (const listener of keyDown) listener({ browserEvent });
	};
	return { monaco, editor, placed, semanticProviders, layout, contextKeys, pressKey, position: () => position };
}

type Tab = NonNullable<MountEditorDeps['tabs']['activeTab']>;

let teardown: (() => void) | undefined;
afterEach(() => {
	teardown?.();
	teardown = undefined;
});

function mount({
	tab,
	fontIsMonospace = true,
	zoomLevel = 100,
	sharedCursor = null,
}: {
	tab: Partial<Tab>;
	fontIsMonospace?: boolean;
	zoomLevel?: number;
	sharedCursor?: { line: number; column: number } | null;
}) {
	const fake = fakeMonaco(fontIsMonospace);
	const reports: string[] = [];
	const events: string[] = [];
	let editor!: Monaco.editor.IStandaloneCodeEditor;
	let monospace = true;
	let ready = false;
	window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;

	teardown = mountEditor({
		monaco: fake.monaco as never,
		container: document.createElement('div'),
		doc: {
			currentTabId: null,
			acquireTabModel: () => ({}),
			contentChanged() {},
			syncStatus() {},
			cancelPendingWordCount() {},
			writePosition() {},
		} as never,
		jumps: {
			spendPending: () => {
				events.push(`pending sync spent, ready=${ready}`);
				fake.placed.push({ what: 'pending sync', layout: fake.layout() });
			},
		},
		tabs: {
			activeTabId: 'tab',
			activeTab: { editorViewState: null, anchorLine: asRendererLine(0), scrollPercentage: 0, ...tab } as Tab,
		},
		settings,
		value: Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'),
		language: 'markdown',
		theme: () => 'light',
		zoomLevel,
		readOnly: false,
		sharedCursor,
		oncursor: (line, column) => reports.push(`${line}:${column}`),
		keyHandlers: {
			cutToClipboard() {},
			pasteFromClipboard() {},
			continueListOnEnter() {},
			handleTabKey() {},
			handleShiftTabKey() {},
			handleModEnterKey() {},
			handleModShiftEnterKey() {},
		},
		// Editor.svelte's `applySettingsOptions`, over the state the setters write.
		applySettingsOptions: () => editor.updateOptions(updatedEditorOptions(settings, zoomLevel, monospace, false)),
		setEditor: (created) => (editor = created),
		setFontIsMonospace: (value) => (monospace = value),
		setCursorPosition() {},
		setSelectionCount() {},
		setCursorCount() {},
		setEditorReady: (value) => {
			ready = value;
			events.push(`ready=${value}`);
		},
	});

	// The layout the settings effect settles on once `editorReady` flips.
	const settled = updatedEditorOptions(settings, zoomLevel, monospace, false);
	return { ...fake, reports, events, final: { fontSize: settled.fontSize, wrappingStrategy: settled.wrappingStrategy } };
}

describe('editor mount', () => {
	test('the editor has its final layout before anything is placed in it', () => {
		// Zoomed, and in either kind of font: the zoom and the wrapping are the
		// two ways the created editor used to differ from the one the update
		// effect left behind.
		const tabs = [
			{ editorViewState: { position: { lineNumber: 40, column: 1 } } },
			{ anchorLine: asRendererLine(30) },
			{ scrollPercentage: 0.5 },
		];
		const cases = [true, false].flatMap((fontIsMonospace) => tabs.map((tab) => ({ tab, fontIsMonospace })));
		for (const { tab, fontIsMonospace } of cases) {
			const run = mount({ tab, fontIsMonospace, zoomLevel: 150 });
			assert.equal(run.placed.length, 2, `placed: ${run.placed.map((p) => p.what).join(', ')}`);
			for (const { what, layout } of run.placed) {
				assert.deepEqual(layout, run.final, `the ${what} is placed under the final layout`);
			}
			assert.deepEqual(
				run.events,
				['ready=true', 'pending sync spent, ready=true'],
				'the pending sync is spent once the editor is ready',
			);
			teardown?.();
			teardown = undefined;
		}
	});

	test('the editor mounts on the cursor the preview placed', () => {
		const run = mount({
			tab: { editorViewState: { position: { lineNumber: 40, column: 1 } } },
			sharedCursor: { line: 7, column: 3 },
		});
		assert.deepEqual(run.position(), { lineNumber: 7, column: 3 }, 'the shared cursor beats the view state');
		assert.deepEqual(run.reports, ['7:3'], 'and is what the editor reports on mount');
	});

	test('the editor registers the semantic tokens provider', () => {
		// The switch half is editor.test.ts "the editor turns the semantic layer
		// on, because the default is off".
		const run = mount({ tab: {} });
		assert.equal(run.semanticProviders.length, 1);
		const [entry] = run.semanticProviders;
		assert.equal(entry.languageId, 'markdown');
		assert.deepEqual(entry.provider.getLegend().tokenTypes, [...TOKEN_TYPES]);

		teardown?.();
		teardown = undefined;
		assert.ok(entry.disposed, 'and releases it on unmount');
	});

	test('AltGr+Z sets the AltGr context key, so the Ctrl+Alt actions refuse it', () => {
		// Windows sends AltGr as Ctrl+Alt with AltGraph on, so Polish AltGr+Z (ż)
		// is also Ctrl+Alt+Z, Zen mode. Monaco ignores AltGraph when it resolves
		// a keystroke; the editor's own keydown sets `altGraphChord`, which every
		// Ctrl+Alt action's `keybindingContext` refuses (editor.actions.test.ts).
		// jsdom cannot say whether WebView2 reports AltGraph; the event sets it.
		const run = mount({ tab: {} });
		assert.equal(run.contextKeys.get('altGraphChord'), false, 'off until a key is pressed');

		run.pressKey({ key: 'ż', code: 'KeyZ', ctrlKey: true, altKey: true, modifierAltGraph: true });
		assert.equal(run.contextKeys.get('altGraphChord'), true, 'AltGr+Z is an AltGr chord');

		run.pressKey({ key: 'z', code: 'KeyZ', ctrlKey: true, altKey: true });
		assert.equal(run.contextKeys.get('altGraphChord'), false, 'a real Ctrl+Alt+Z clears it, so Zen mode still works');
	});
});
