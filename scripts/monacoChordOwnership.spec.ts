import assert from 'node:assert/strict';

import { decodeKeybinding, type KeyCodeChord } from 'monaco-editor/esm/vs/base/common/keybindings.js';
import { KeyCode } from 'monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js';
import { KeyMod } from 'monaco-editor/esm/vs/editor/common/services/editorBaseApi.js';
import { beforeAll, expect, test, vi } from 'vitest';

import { PLATFORMS, editorKeymap, label, type Chord } from './keymapHarness.js';
import { readSource } from './sourceTree.js';

/*
 * WHO OWNS A CHORD: the app, or Monaco?
 *
 * `editor.addAction` registers at weight 1000 and every Monaco default sits at
 * 0 or 100, so when the app and Monaco want the same chord the app wins —
 * silently. There is no warning, no console message, and the Monaco command
 * simply stops having a key. That is fine for a command nobody misses and
 * catastrophic for one the user cannot do any other way.
 *
 * It has already gone wrong once. `toggle-zen-mode` took Ctrl/Cmd+Shift+Z,
 * which on macOS is `redo`'s ONLY editor binding — Monaco gives redo
 * `Cmd+Y` + `Cmd+Shift+Z` on Windows and Linux but only `Cmd+Shift+Z` on
 * macOS (`editorExtensions.js`). Mac users lost keyboard redo entirely, and no
 * test could see it, because the only description of Monaco's keymap in the
 * suite was eleven rows hand-copied into `formatShortcutKeymap.test.ts`.
 *
 * WHERE MONACO'S KEYMAP COMES FROM HERE
 *
 * It is read, not copied. `monaco-editor` is imported for real under jsdom and
 * `KeybindingsRegistry.getDefaultKeybindings()` is dumped, once per platform.
 * That is also why this file is a `.spec.ts` (vitest, jsdom) rather than a
 * `.test.ts`: loading the editor bundle needs a DOM and a CSS-aware transform,
 * and the node runner has neither.
 *
 * WHAT IT DOES NOT ESTABLISH
 *
 * The same limits as `keymapHarness.ts`: this is the keymap both sides
 * DECLARE. Resolution order, `when` clauses and the vim adapter live in a
 * running WebView. What it does establish is that no future registration can
 * take a key off Monaco without saying so out loud, below.
 */

// ------------------------------------------------------- Monaco's own keymap

/**
 * The user agent each platform is emulated with, and the `process.platform`
 * that goes with it.
 *
 * BOTH are needed, and the reason is the awkward half of this file.
 * `vs/base/common/platform.js` picks its branch by asking whether a Node
 * `process` exists BEFORE it looks at `navigator`: under vitest one does, so
 * an unmodified import takes the NATIVE branch and reports `isNative === true`.
 *
 * Markpad runs in a Tauri WebView, which is the web branch, and the difference
 * is not cosmetic — `clipboard.js` binds Ctrl/Cmd+X/C/V only when `isNative`,
 * "since browsers do that for us". A native-mode dump therefore claims Monaco
 * owns the three clipboard chords that the app binds itself (`Editor.svelte`
 * says as much where it binds them), and would demand three allow-list entries
 * for a conflict that does not exist in the shipped app.
 *
 * So the import is made to take the web branch by hiding `process.versions.node`
 * for its duration, and the platform then comes from the user agent. Both facts
 * are asserted after the import rather than assumed.
 */
const PLATFORM_ENV = {
	macOS: {
		platform: 'darwin',
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
	},
	Windows: {
		platform: 'win32',
		userAgent:
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	},
	Linux: {
		platform: 'linux',
		userAgent:
			'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	},
} as const satisfies Record<(typeof PLATFORMS)[number]['name'], { platform: string; userAgent: string }>;

/** chord -> the Monaco command ids that claim it, for one platform. */
type MonacoKeymap = Map<Chord, string[]>;

async function monacoDefaults(name: keyof typeof PLATFORM_ENV): Promise<MonacoKeymap> {
	const env = PLATFORM_ENV[name];
	const realPlatform = process.platform;
	const realVersions = process.versions;

	vi.resetModules();
	// jsdom has no `queryCommandSupported`; Chromium answers yes, and without it
	// `clipboard.js` throws before the registry is populated at all.
	(document as unknown as { queryCommandSupported: () => boolean }).queryCommandSupported = () => true;
	Object.defineProperty(navigator, 'userAgent', { value: env.userAgent, configurable: true });
	Object.defineProperty(process, 'platform', { value: env.platform, configurable: true });
	Object.defineProperty(process, 'versions', {
		value: { ...realVersions, node: undefined },
		configurable: true,
	});

	try {
		await import('monaco-editor');
		const { KeybindingsRegistry } = await import(
			'monaco-editor/esm/vs/platform/keybinding/common/keybindingsRegistry.js'
		);
		const platform = await import('monaco-editor/esm/vs/base/common/platform.js');

		// The two facts the dump silently depends on. If a Monaco upgrade or a
		// vitest change flips either, every assertion below would still pass while
		// measuring the wrong editor.
		assert.equal(platform.isNative, false, `${name}: Monaco took its native branch; the WebView is the web branch`);
		assert.equal(platform.isMacintosh, name === 'macOS', `${name}: Monaco disagrees about which platform this is`);

		const keymap: MonacoKeymap = new Map();
		for (const item of KeybindingsRegistry.getDefaultKeybindings()) {
			if (!item.keybinding) continue;
			const chord = item.keybinding.chords.map((c: KeyCodeChord) => label(c)).join(' ');
			keymap.set(chord, [...new Set([...(keymap.get(chord) ?? []), item.command as string])]);
		}

		// Empty-iteration guard: without it a Monaco upgrade that moved the
		// registry would turn every rule below into a test that passes while
		// checking nothing. Monaco 0.55.1 registers 366 / 299 / 293 keybindings
		// on macOS / Windows / Linux, over 223 / 165 / 161 DISTINCT chords —
		// far fewer, because a chord is shared by every `when`-gated variant of
		// the same key.
		assert.ok(keymap.size > 120, `${name}: Monaco declared only ${keymap.size} chords; the dump is not real`);
		return keymap;
	} finally {
		Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
		Object.defineProperty(process, 'versions', { value: realVersions, configurable: true });
	}
}

// ---------------------------------------------------------- the app's keymap

/**
 * Every chord the app registers on the editor, and what registers it.
 *
 * `editorKeymap` covers the `addAction` list. The bare `addCommand` calls live
 * in `createEditor`, 500 lines of Monaco setup the action harness cannot run,
 * so their keybinding EXPRESSIONS are lifted out of the source and evaluated
 * against the real `KeyMod`/`KeyCode` — the numbers are Monaco's, not a
 * transcription. Both kinds outrank Monaco's defaults, so leaving the commands
 * out would have left a hole exactly where Enter and Tab are bound. A command
 * carries no id, so it is named after the function it runs, which is the name a
 * reader of the failure wants anyway.
 */
function appEditorChords(mac: boolean, os: 1 | 2 | 3): Map<Chord, string[]> {
	const chords = new Map<Chord, string[]>();
	const claim = (chord: Chord, owner: string) =>
		chords.set(chord, [...(chords.get(chord) ?? []), owner]);

	for (const [id, list] of editorKeymap(mac, os)) {
		for (const chord of list) claim(chord, id);
	}

	const source = readSource('src/lib/components/Editor.svelte');
	const commands = [...source.matchAll(/\beditor\.addCommand\(\s*([^,]+),\s*(\w+)\s*[,)]/g)];
	assert.ok(commands.length >= 2, `found ${commands.length} addCommand calls; the extraction stopped matching`);
	for (const [, expression, fn] of commands) {
		const binding = new Function('monaco', `return ${expression}`)({ KeyMod, KeyCode }) as number;
		claim(chordOf(binding, os), `addCommand(${fn})`);
	}

	return chords;
}

/** One keybinding number as the chord Monaco resolves it to on `os`. */
function chordOf(binding: number, os: 1 | 2 | 3): Chord {
	const decoded = decodeKeybinding(binding, os);
	assert.ok(decoded, `Monaco could not decode keybinding ${binding}`);
	return decoded.chords.map((chord) => label(chord)).join(' ');
}


type PlatformName = (typeof PLATFORMS)[number]['name'];

/** The chord a rule is about, per platform. A platform left out has no conflict there. */
type PerPlatform = Partial<Record<PlatformName, Chord>>;

// ------------------------------------------------------- deliberate overrides

/**
 * The chords the app takes off Monaco ON PURPOSE.
 *
 * A row here is not an apology, it is an argument. Taking a key from Monaco is
 * correct only when the app's meaning is the one a Markdown writer expects AND
 * the Monaco command survives the loss — every command below is still reachable
 * from the command palette, and none of them is something the user cannot
 * otherwise do. The ones that ARE are in UNRECOVERABLE, which no row here is
 * allowed to cover.
 *
 * `chords` is per platform because Monaco's keymap is not the same on all
 * three: Cmd+E collides only on macOS, Ctrl+Shift+R only off it. A row that
 * claimed to be universal would hide which command is actually losing its key.
 *
 * A CHORD THAT CANNOT BE ALLOW-LISTED, recorded here so the next person hunting
 * for a free key does not have to rediscover it: `Mod+Alt+C` — `Alt+Meta+C` on
 * macOS — is `toggleFindCaseSensitive`, and it fails the palette test above.
 * Monaco registers it with `registerEditorCommand`, not `registerEditorAction`,
 * and only the latter contributes a `MenuId.CommandPalette` entry
 * (`editorExtensions.js`), so there is no palette fallback: taking the key would
 * leave find-case-sensitivity reachable by mouse alone. Its `kbExpr` is a bare
 * `EditorContextKeys.focus`, so it is live whenever the editor has focus rather
 * than only while the find widget is open. Insert Column wanted this chord —
 * `Mod+Alt+C` pairs with Insert Table's `Mod+Alt+T` — and got `Mod+Shift+C`
 * instead. The same reasoning disqualifies `toggleFindWholeWord` (`Alt+Meta+W`),
 * `toggleFindRegex` (`Alt+Meta+R`) and `toggleFindInSelection` (`Alt+Meta+L`),
 * which are registered the same way.
 */
type Override = {
	/** The app registration: a Monaco action id, or `addCommand(fn)` for a bare command. */
	action: string;
	chords: PerPlatform;
	/**
	 * The Monaco command that loses the key. For a `namespace` row it is one
	 * command from BEHIND the prefix, named so the row fails if the prefix stops
	 * meaning what the argument says it means.
	 */
	monaco: string;
	/**
	 * The chord is a PREFIX of Monaco chord sequences rather than a chord Monaco
	 * binds outright, so what the app takes is a whole namespace.
	 *
	 * This exists because the first rule below could not see that case at all.
	 * `Mod+K` is not a key in Monaco's map — every `Mod+K …` entry is keyed by the
	 * full two-part chord — so an app action claiming plain `Mod+K` matched
	 * nothing, and the rule waved through the single largest keymap change this
	 * app has ever made. A guard that only notices exact collisions is blind
	 * exactly where the loss is biggest.
	 */
	namespace?: true;
	/** Why losing it is acceptable. */
	why: string;
};

const DELIBERATE_OVERRIDES: readonly Override[] = [
	{
		action: 'fmt-link',
		chords: { macOS: 'Meta+K', Windows: 'Ctrl+K', Linux: 'Ctrl+K' },
		namespace: true,
		monaco: 'editor.foldAll',
		why:
			"THE LARGEST THING THIS APP TAKES OFF MONACO, and the cost is enumerated rather than " +
			'summarised because a reader arriving later deserves the actual bill. Monaco binds no complete ' +
			'keybinding on Ctrl/Cmd+K; it binds 31 chord SEQUENCES behind it, carrying 30 commands, ' +
			'identically on all three platforms. Twenty are folding (foldAll, unfoldAll, foldLevel1-7, ' +
			'foldRecursively, unfoldRecursively, foldAllExcept, unfoldAllExcept, toggleFold, ' +
			'toggleFoldRecursively, foldAllBlockComments, foldAllMarkerRegions, unfoldAllMarkerRegions, ' +
			'createFoldingRangeFromSelection, removeManualFoldingRanges). The other ten are addCommentLine, ' +
			'removeCommentLine, formatSelection, revealDefinitionAside, togglePeekWidgetFocus, ' +
			'setSelectionAnchor, selectFromAnchorToCursor, moveSelectionToNextFindMatch, showHover and ' +
			'trimTrailingWhitespace. All 30 remain in the command palette (Mod+P); what goes is the key. ' +
			'WHY THE FOLDING BULK IS NOT THE LOSS IT LOOKS LIKE: editor folding barely works in this app to ' +
			'begin with. Nothing in src/ registers a folding-range provider — grep registerFoldingRangeProvider ' +
			"— and Monaco's own basic-languages/markdown/markdown.js declares folding only through region " +
			'markers (<!-- #region --> / <!-- #endregion -->), which nobody writes in Markdown. What those ' +
			"twenty commands actually operate on is indentation folding. The folding a user of this app has " +
			'and wants is the preview-side system in src/lib/utils/foldState.ts, which is click-driven and ' +
			'untouched by any of this. No replacement fold chords are added, deliberately. ' +
			'WHAT IS BOUGHT: Ctrl/Cmd+K is Insert Link in Typora, Bear, iA Writer and GitHub — the only ' +
			'command in the whole survey where four independent sources agree exactly — and the link button ' +
			'had no keyboard shortcut at all. A prose editor spending its single most agreed-on chord on a ' +
			'code-folding namespace nobody can reach was the trade being made silently in the other direction.',
	},
	{
		action: 'fmt-italic',
		chords: { macOS: 'Meta+I', Windows: 'Ctrl+I', Linux: 'Ctrl+I' },
		monaco: 'editor.action.triggerSuggest',
		why: 'Ctrl/Cmd+I is italic in every writing tool there is, and this is a Markdown editor. Suggest keeps Ctrl+Space, its primary binding on all three platforms. The two riders on the same chord (focusSuggestion, toggleSuggestionDetails) are `when`-gated on the suggest widget being open, which it cannot be if nothing opened it.',
	},
	{
		action: 'fmt-underline',
		chords: { macOS: 'Meta+U', Windows: 'Ctrl+U', Linux: 'Ctrl+U' },
		monaco: 'cursorUndo',
		why: 'Ctrl/Cmd+U is underline in every word processor. `cursorUndo` undoes a CURSOR MOVE, not an edit: no text is at risk, and the command stays in the palette. It is not `undo`, which is protected below.',
	},
	{
		action: 'fmt-quote',
		chords: { macOS: 'Shift+Meta+.', Windows: 'Ctrl+Shift+.', Linux: 'Ctrl+Shift+.' },
		monaco: 'editor.action.inPlaceReplace.down',
		why: "GitHub's blockquote chord, and Shift+. IS the `>` marker. Argued at the binding itself in Editor.svelte and again in formatShortcutKeymap.test.ts; `inPlaceReplace` cycles enum-ish words in code and has nothing to cycle in prose.",
	},
	{
		action: 'view-toggle-edit',
		chords: { macOS: 'Meta+E' },
		monaco: 'actions.findWithSelection',
		why: 'Cmd+E for edit/read is the mainstream Markdown reading (Obsidian, Mark Text). `findWithSelection` is a mac-only Monaco binding of the macOS "use selection for find" convention; this app has no find bar of its own for it to seed, and Cmd+F opens find with or without it.',
	},
	{
		action: 'view-toggle-live',
		chords: { macOS: 'Meta+L', Windows: 'Ctrl+L', Linux: 'Ctrl+L' },
		monaco: 'expandLineSelection',
		why: 'Live preview is a top-level view mode here and sits beside Cmd+E. `expandLineSelection` is a selection convenience, still in the palette, and Home then Shift+End does the same thing.',
	},
	{
		action: 'file-reveal',
		chords: { Windows: 'Ctrl+Shift+R', Linux: 'Ctrl+Shift+R' },
		monaco: 'editor.action.refactor',
		why: 'Refactor has nothing to act on in a Markdown document — no language service is registered, so the command opens an empty picker. R is for Reveal, and macOS has no conflict on this chord at all.',
	},
	{
		action: 'addCommand(continueListOnEnter)',
		chords: { macOS: 'Enter', Windows: 'Enter', Linux: 'Enter' },
		monaco: 'acceptSelectedSuggestion',
		why: 'List continuation (#604). The only conditional row in this table: its `when` clause excludes editorTextFocus=false, readonly, suggestWidgetVisible and inSnippetMode, so every Monaco command sharing Enter still gets the key in the state it cares about, and off a list item the handler re-triggers a plain Enter. See the block above the binding in Editor.svelte.',
	},
	{
		action: 'addCommand(handleTabKey)',
		chords: { macOS: 'Tab', Windows: 'Tab', Linux: 'Tab' },
		monaco: 'tab',
		why: 'Table cell / list indentation (#604), same clause as Enter plus `!editorTabMovesFocus` so the accessibility toggle still wins. Was `indentListItemOnTab` until the table keys landed and the dispatch grew a table branch in front of the list one. Outside both it re-triggers the ordinary Tab.',
	},
	{
		action: 'addCommand(handleShiftTabKey)',
		chords: { macOS: 'Shift+Tab', Windows: 'Shift+Tab', Linux: 'Shift+Tab' },
		monaco: 'outdent',
		why: '#636 deliberately left Shift+Tab alone, on the grounds that core `outdent` already owned it and did it right. Tables broke the tie: a table has a PREVIOUS CELL and core has no command for it — the exception #636\'s own failure message named. The handler hands the chord straight back (`editor.trigger("keyboard", "outdent", null)`) everywhere the table branch declines, so outside a table the behaviour is byte-for-byte Monaco\'s.',
	},
	{
		action: 'addCommand(handleModEnterKey)',
		chords: { macOS: 'Meta+Enter', Windows: 'Ctrl+Enter', Linux: 'Ctrl+Enter' },
		monaco: 'editor.action.insertLineAfter',
		why: 'THE KEY IS SPECIALISED, NOT TAKEN. Inside a table "insert the line below" IS "insert the row below", so the meaning is unchanged; everywhere else the handler re-triggers `insertLineAfter` itself. The other claimants on this chord (replaceAll, the references peek, quickInput.accept, previewSelectedCodeAction) are all gated on contexts where `editorTextFocus` is false, which the shared clause requires.',
	},
	{
		action: 'addCommand(handleModShiftEnterKey)',
		chords: { macOS: 'Shift+Meta+Enter', Windows: 'Ctrl+Shift+Enter', Linux: 'Ctrl+Shift+Enter' },
		monaco: 'editor.action.insertLineBefore',
		why: 'The mirror of Mod+Enter above, and the same argument: a row above rather than a line above, and a straight re-trigger of `insertLineBefore` outside a table. `insertLineBefore` is the only Monaco claimant on this chord.',
	},
];

// --------------------------------------------------------- the protected set

/**
 * The chords whose loss the user cannot work around.
 *
 * NOT an allow-list — the opposite. A row here can never be answered with a
 * DELIBERATE_OVERRIDES entry, because there is no argument that would make it
 * correct: every Monaco command this file lets the app take is still reachable
 * from the command palette, and these are the ones where losing the key means
 * losing the ability.
 *
 * `monaco` is the command that must still own the chord; `app` is the app
 * registration allowed to own it instead, for the chords Monaco deliberately
 * leaves free in a browser. Exactly one of the two is set, and naming both ends
 * is what makes a row fail if EITHER moves — a rule that only said "the app
 * must not claim redo's chord" would go on passing if Monaco stopped binding
 * redo at all.
 */
type Protected = {
	what: string;
	chords: PerPlatform;
	monaco: string | null;
	app: string | null;
};

const UNRECOVERABLE: readonly Protected[] = [
	// THE regression this file exists for. On macOS Shift+Meta+Z is redo's ONLY
	// binding — Monaco's mac override replaces the default rule outright rather
	// than adding to it, so Cmd+Y is not a fallback there — and `toggle-zen-mode`
	// took it, at weight 1000, leaving mac users with no keyboard redo at all.
	{ what: 'undo', chords: { macOS: 'Meta+Z', Windows: 'Ctrl+Z', Linux: 'Ctrl+Z' }, monaco: 'undo', app: null },
	{ what: 'redo', chords: { macOS: 'Shift+Meta+Z', Windows: 'Ctrl+Shift+Z', Linux: 'Ctrl+Shift+Z' }, monaco: 'redo', app: null },
	{ what: 'redo (the second binding macOS does not get)', chords: { Windows: 'Ctrl+Y', Linux: 'Ctrl+Y' }, monaco: 'redo', app: null },

	{ what: 'select all', chords: { macOS: 'Meta+A', Windows: 'Ctrl+A', Linux: 'Ctrl+A' }, monaco: 'editor.action.selectAll', app: null },

	// Cut, copy and paste are the APP's on every platform. Monaco leaves them
	// unbound in a browser on purpose ("browsers do that for us" — clipboard.js),
	// which is why Editor.svelte binds them; `monaco: null` is what fails if a
	// future Monaco starts claiming them back.
	{ what: 'cut', chords: { macOS: 'Meta+X', Windows: 'Ctrl+X', Linux: 'Ctrl+X' }, monaco: null, app: 'addCommand(cutToClipboard)' },
	{ what: 'copy', chords: { macOS: 'Meta+C', Windows: 'Ctrl+C', Linux: 'Ctrl+C' }, monaco: null, app: 'custom-copy' },
	{ what: 'paste', chords: { macOS: 'Meta+V', Windows: 'Ctrl+V', Linux: 'Ctrl+V' }, monaco: null, app: 'addCommand(pasteFromClipboard)' },

	// Save: Monaco has no save command at all, so this row exists so that a
	// future Monaco binding on Ctrl/Cmd+S is a failure rather than a silent race
	// against the one thing that keeps the user's work.
	{ what: 'save', chords: { macOS: 'Meta+S', Windows: 'Ctrl+S', Linux: 'Ctrl+S' }, monaco: null, app: 'file-save' },
];

// ------------------------------------------------------------------- the rules

/**
 * Each platform's keymap is dumped once and shared by every rule below.
 *
 * Up front in a `beforeAll` rather than lazily inside the first rule, because
 * importing the editor bundle three times costs several seconds and would
 * otherwise land on whichever test happens to run first — and blow that one
 * test's default 5s budget while the identical work is free for the other four.
 */
const keymaps = new Map<string, MonacoKeymap>();
const defaultsFor = (name: PlatformName) => keymaps.get(name)!;

beforeAll(async () => {
	for (const platform of PLATFORMS) keymaps.set(platform.name, await monacoDefaults(platform.name));
}, 120_000);

/** Every (row, platform) pair a per-platform table actually makes a claim about. */
function* rows<T extends { chords: PerPlatform }>(table: readonly T[]) {
	for (const row of table) {
		for (const platform of PLATFORMS) {
			const chord = row.chords[platform.name];
			if (chord) yield { row, platform, chord };
		}
	}
}

test('every chord the app takes off Monaco is one it says out loud it is taking', async () => {
	const unexplained: string[] = [];

	for (const platform of PLATFORMS) {
		const monaco = defaultsFor(platform.name);
		for (const [chord, owners] of appEditorChords(platform.mac, platform.os)) {
			const losers = monaco.get(chord);
			if (!losers) continue;

			const allowed = DELIBERATE_OVERRIDES.some(
				(o) => o.chords[platform.name] === chord && owners.includes(o.action),
			);
			if (allowed) continue;

			unexplained.push(`${platform.name}: ${owners.join('/')} takes ${chord} from Monaco's ${losers.join(', ')}`);
		}
	}

	assert.deepEqual(
		unexplained,
		[],
		'A registration outranks every Monaco default, so each of these silently disables a Monaco command.\n' +
			'Move the binding, or add a DELIBERATE_OVERRIDES row arguing why the loss is acceptable:\n  ' +
			unexplained.join('\n  '),
	);
});

/** The Monaco chord SEQUENCES that begin with `chord`, on one platform. */
function sequencesUnder(monaco: MonacoKeymap, chord: Chord): Array<[Chord, string[]]> {
	return [...monaco].filter(([candidate]) => candidate.startsWith(`${chord} `));
}

test('a chord taken off a Monaco chord NAMESPACE is one the app says out loud it is taking', () => {
	// The blind spot in the rule above, and the reason this file grew a second
	// one. Monaco keys its map by the FULL chord, so `Meta+K` — the prefix of 31
	// sequences — is not in it, and `monaco.get('Meta+K')` is undefined. An app
	// action registering plain `Mod+K` therefore reported no conflict at all,
	// while ending every `Mod+K …` command in the editor: once the first key
	// resolves to a complete keybinding there is no second key to press.
	//
	// Losing a namespace is a bigger decision than losing one command, so it needs
	// a louder rule rather than a quieter one.
	const unexplained: string[] = [];

	for (const platform of PLATFORMS) {
		const monaco = defaultsFor(platform.name);
		for (const [chord, owners] of appEditorChords(platform.mac, platform.os)) {
			if (chord.includes(' ')) continue; // a sequence shadows no prefix
			const shadowed = sequencesUnder(monaco, chord);
			if (!shadowed.length) continue;

			const allowed = DELIBERATE_OVERRIDES.some(
				(o) => o.namespace && o.chords[platform.name] === chord && owners.includes(o.action),
			);
			if (allowed) continue;

			const commands = new Set(shadowed.flatMap(([, ids]) => ids));
			unexplained.push(
				`${platform.name}: ${owners.join('/')} takes ${chord} as a whole key, ending ` +
					`${shadowed.length} Monaco chord sequences behind it (${commands.size} commands)`,
			);
		}
	}

	assert.deepEqual(
		unexplained,
		[],
		'Claiming a chord that Monaco uses as a chord PREFIX does not collide with one command, it\n' +
			'ends a namespace: the first key now resolves and there is no second key to press.\n' +
			'Move the binding, or add a DELIBERATE_OVERRIDES row with `namespace: true` whose `why`\n' +
			'enumerates what is behind the prefix rather than eliding it:\n  ' +
			unexplained.join('\n  '),
	);
});

test('no row in the allow-list has gone stale', async () => {
	// Without this the table only ever grows: a row left behind after its binding
	// moved reads as a live justification for a conflict that no longer exists,
	// and the next reader believes it.
	for (const { row, platform, chord } of rows(DELIBERATE_OVERRIDES)) {
		const monaco = defaultsFor(platform.name);
		const owners = appEditorChords(platform.mac, platform.os).get(chord);

		assert.ok(owners?.includes(row.action), `${platform.name}: ${row.action} no longer binds ${chord}`);

		// A namespace row's Monaco side is behind the prefix, not on it — looking the
		// chord up directly would find nothing and delete a live justification.
		const claimants = row.namespace
			? sequencesUnder(monaco, chord).flatMap(([, ids]) => ids)
			: (monaco.get(chord) ?? []);
		assert.ok(
			claimants.includes(row.monaco),
			`${platform.name}: Monaco no longer binds ${row.monaco} ${row.namespace ? 'behind' : 'to'} ${chord}; delete the override`,
		);
		assert.ok(row.why.length > 80, `${row.action} on ${chord} carries no real justification`);
	}
});

test('the chords a user cannot live without still belong to whoever owns them', async () => {
	for (const { row, platform, chord } of rows(UNRECOVERABLE)) {
		const monaco = defaultsFor(platform.name);
		const app = appEditorChords(platform.mac, platform.os).get(chord) ?? [];
		const where = `${platform.name}: ${row.what} (${chord})`;

		if (row.monaco) {
			assert.ok(
				monaco.get(chord)?.includes(row.monaco),
				`${where} is Monaco's ${row.monaco}, and Monaco no longer binds it there`,
			);
			assert.deepEqual(app, [], `${where} is Monaco's ${row.monaco}, but the app claims it as ${app.join('/')}`);
		} else {
			assert.deepEqual(app, [row.app], `${where} must be answered by ${row.app}, not by ${app.join('/') || 'nothing'}`);
			assert.equal(
				monaco.get(chord),
				undefined,
				`${where} is the app's only because Monaco leaves it free in a browser; Monaco now binds ${monaco.get(chord)?.join(', ')}`,
			);
		}
	}
});

test('the unrecoverable set has no allow-list escape hatch', () => {
	// The rule above only holds if nobody can answer a protected collision by
	// appending a row to DELIBERATE_OVERRIDES, which is what the next person
	// under a deadline will reach for.
	for (const { row, platform, chord } of rows(DELIBERATE_OVERRIDES)) {
		const clash = UNRECOVERABLE.find((p) => p.chords[platform.name] === chord);
		assert.equal(
			clash,
			undefined,
			`${row.action} may not be allow-listed onto ${chord} on ${platform.name}: that chord is ${clash?.what}`,
		);
	}
});

test('zen mode is off redo, and on a chord nothing else wants', async () => {
	// The defect itself, asserted where a reader will look for it rather than
	// left implicit in the rules above. Confirmed by hand on a debug build
	// first: Cmd+Shift+Z entered zen mode and nothing redid.
	for (const platform of PLATFORMS) {
		const chord = platform.mac ? 'Alt+Meta+Z' : 'Ctrl+Alt+Z';
		expect(editorKeymap(platform.mac, platform.os).get('toggle-zen-mode'), platform.name).toEqual([chord]);
		expect(defaultsFor(platform.name).get(chord), platform.name).toBeUndefined();
	}
});
