import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	readSource,
	sliceBetween,
	sliceFrom,
	offsetOf,
} from './sourceTree.js';

describe('cross-window tab transfer wiring', () => {
	// insertTransferredTab lives in the Svelte store ($state rune, not loadable
	// in node), so — like windowStateRestore.spec.ts — the thin store wrapper is
	// checked statically; all decision logic above is exercised directly.
	test('insertTransferredTab is a thin wrapper: build, push, activate, return the id', () => {
		const tabs = readSource('src/lib/stores/tabs.svelte.ts');
		const fn = sliceBetween(tabs, 'insertTransferredTab(', 'closeTab(');

		assert.match(fn, /buildTransferredTab\(/);
		// untitled re-numbering uses this window's titles and localized base
		assert.match(fn, /this\.tabs\.map\(\(tab\) => tab\.title\)/);
		assert.match(fn, /t\('tabs\.untitled', settings\.language\)/);
		// the new tab is pushed, activated, and its id returned
		assert.match(fn, /this\.tabs\.push\(tab\);/);
		assert.match(fn, /this\.activeTabId = tab\.id;/);
		assert.match(fn, /return tab\.id;/);
	});

	test('serializeState still persists window shape only (untouched by transfer)', () => {
		const tabs = readSource('src/lib/stores/tabs.svelte.ts');
		const fn = sliceBetween(tabs, 'serializeState(extra', 'restoreState(');
		assert.doesNotMatch(fn, /rawContent/);
		assert.doesNotMatch(fn, /TransferableTab/);
	});

	test('source removal waits for destination completion', () => {
		const broker = readSource('src-tauri/src/tab_transfer.rs');
		const session = readSource('src/lib/sessions/windowSession.svelte.ts');

		assert.match(broker, /pub fn complete_detached_tab/);
		const claim = sliceBetween(broker, 'pub fn claim_detached_tab', 'pub fn complete_detached_tab');
		assert.doesNotMatch(claim, /tab-transfer-claimed/);
		assert.match(session, /invoke\('complete_detached_tab', \{ token \}\)/);
	});
});

describe('tab transfer handoff', () => {
	const session = readSource(new URL('../src/lib/sessions/windowSession.svelte.ts', import.meta.url));
	const broker = readSource(new URL('../src-tauri/src/tab_transfer.rs', import.meta.url));

	// A tab transfer is only ever allowed to end in one of two states: the source
	// still has the tab, or the destination does. Every defect below produced the
	// third state -- present in both windows, each with its own auto-save timer
	// writing over the other.

	test('the source keeps waiting when the destination has already claimed', () => {
		// The 15s timeout is a guess about a window that may simply be slow to
		// render. Cancelling regardless is what stranded a copy on each side.
		const cancel = sliceFrom(session, 'const cancel = async ()');
		assert.match(cancel, /outcome\.cancelled/);
		assert.match(cancel, /outcome\.claimed/);
		assert.match(cancel, /if \(!outcome\.cancelled && outcome\.claimed\) \{\s*\n\s*setTimeout\(cancel, 15_000\);\s*\n\s*return;/);
	});

	test('the destination releases its claim when it cannot finish', () => {
		// Because a claimed transfer is immune to the source's timeout, the
		// destination is the only party that can end a claim it cannot complete.
		assert.match(session, /async function releaseClaim\(token: string\)/);
		const accept = sliceBetween(session, 'async function acceptOfferedTransfer', 'async function claimTransferredTab');
		// Invalid payload, a refusing destination, and a thrown render all release.
		assert.equal((accept.match(/releaseClaim\(token\)/g) ?? []).length, 3);
		assert.match(accept, /if \(claimed\) await releaseClaim\(token\);/);
	});

	test('a claim is distinguished from "no such token"', () => {
		// Releasing a token that was never claimed would be a no-op at best and a
		// cancel of someone else's transfer at worst.
		const accept = sliceBetween(session, 'async function acceptOfferedTransfer', 'async function claimTransferredTab');
		assert.match(accept, /if \(payload === null\)/);
		assert.match(accept, /claimed = true;/);
	});

	test('a second transfer of the same tab is refused while one is in flight', () => {
		// The menu entry becomes clickable again long before the transfer
		// resolves; two payloads for one tab means two windows each build it.
		assert.match(session, /const transfersInFlight = new Set<string>\(\);/);
		assert.match(session, /if \(transfersInFlight\.has\(tabId\)\) return false;/);
		assert.match(session, /\} finally \{\s*\n\s*transfersInFlight\.delete\(tabId\);/);
	});

	test('the broker binds every operation to the window that may perform it', () => {
		// Tokens used to be t1..t16, and any webview could read or destroy any
		// staged transfer -- including the document text of a drag in progress.
		assert.match(broker, /fn is_destination_label/);
		assert.match(broker, /enum CancelAuthority/);
		assert.doesNotMatch(broker, /format!\("t\{\}"/);
	});

	test('eviction never drops a transfer that is mid-handoff', () => {
		assert.match(broker, /fn eviction_victim/);
		assert.match(broker, /claimed_at/);
	});
});

describe('tab switch is not a render', () => {
	/**
	 * The switch-time transition suppression is a contract between two files, and
	 * both halves fail silently on their own.
	 *
	 * The viewer adds a class to `.layout-container`, forces a style recalculation
	 * so the new pane geometry commits while transitions are off, and removes it —
	 * in one statement, before the first paint of the switch. The rule that makes
	 * the class mean anything lives in `styles.css`.
	 *
	 * Neither half can be a behaviour test: the ordering being asserted is
	 * "the class is on the element during the browser's style recalculation", and
	 * jsdom has no style recalculation to be inside of.
	 *
	 * The interesting failure is the third assertion. Svelte deletes scoped
	 * selectors it cannot see applied in the markup, and this class is applied
	 * through `classList` — so moving these rules into the component's `<style>`
	 * block, which is where they look like they belong, compiles them away and
	 * restores every animation with nothing going red.
	 */
	test('a tab switch commits the new pane geometry with transitions off', () => {
		const viewer = readSource('src/lib/MarkdownViewer.svelte');
		const styles = readSource('src/styles.css');

		// The viewer's half: add, force the recalculation, remove. The forced read
		// between the two is the mechanism, not a formality — without it the class
		// is added and removed within one style computation and suppresses nothing.
		assert.match(
			viewer,
			/classList\.add\('tab-switching'\);\s*void [\w.]+\.offsetHeight;\s*[\w.]+\.classList\.remove\('tab-switching'\);/,
			'the viewer must add the class, force a style recalculation, and remove it in one statement',
		);

		// The stylesheet's half, and that it reaches the outline wrapper, whose
		// shadow follows the tab's mode.
		const rule = styles.match(/([^}]*\.layout-container\.tab-switching[^{]*)\{([^}]*)\}/);
		assert.ok(rule, 'styles.css must carry a .tab-switching rule');
		assert.match(rule[1], /\.layout-container\.tab-switching \.toc-overlay-wrapper\b/, 'and it must reach .toc-overlay-wrapper');
		assert.match(rule[2], /transition:\s*none\s*!important/, 'and it must switch transitions off');

		// And that it did not migrate into the component, where Svelte would prune
		// it. `classList.add('tab-switching')` is a string, not a selector, so the
		// check is for the leading dot.
		assert.doesNotMatch(
			viewer,
			/\.tab-switching/,
			'the rule must stay in styles.css: a scoped selector for an imperatively added class is compiled away',
		);
	});

	/**
	 * The preview DOM belongs to the tab, not to the viewer.
	 *
	 * A single `.markdown-blocks` for every tab is what made a switch the worst
	 * case `blockPatch.ts` has: two documents share no block keys, so the diff
	 * replaced essentially every node, `renderRichContent` ran over the whole
	 * document again, every fold re-measured, and the reading position was then
	 * restored against a layout that was still settling.
	 *
	 * `tabSwitchKeepsPreviewDom.spec.ts` runs the mechanism that makes the switch
	 * free — re-patching a host that already holds that document changes nothing —
	 * but it supplies its own two hosts, so it stays green against a viewer that
	 * has gone back to sharing one. This is the half that does not: the host must
	 * be minted inside a keyed `{#each}` over the tabs, which is also what makes
	 * Svelte destroy it with its tab and keeps the set of hosts from drifting from
	 * the set of tabs the way a hand-kept registry can.
	 */
	test('the preview holds one document host per tab, not one for all of them', () => {
		const viewer = readSource('src/lib/MarkdownViewer.svelte');

		const each = viewer.match(
			/\{#each tabManager\.tabs as tab \(tab\.id\)\}([\s\S]*?)\{\/each\}/g,
		);
		assert.ok(each, 'the viewer must render per-tab preview hosts from a keyed each over the tabs');

		const hostBlock = each.find((block) => block.includes('markdown-blocks'));
		assert.ok(
			hostBlock,
			'.markdown-blocks must be minted per tab — one shared host makes every switch a full rebuild',
		);
		assert.match(
			hostBlock,
			/style:display=\{tab\.id === tabManager\.activeTabId \? null : 'none'\}/,
			'only the active tab\'s host may be displayed, and the hidden ones must cost no layout',
		);

		// And that nothing kept a single binding beside it. The whole property is
		// that there is no element the viewer can write two documents into.
		assert.doesNotMatch(
			viewer,
			/bind:this=\{previewBlocks\}/,
			'previewBlocks is the derived pointer at the active tab\'s host, never a binding of its own',
		);
	});
});

describe('numbered untitled titles', () => {
	test('new tabs are created with numbered untitled titles', () => {
		const tabs = readSource('src/lib/stores/tabs.svelte.ts');
		assert.match(tabs, /nextUntitledTitle\(/);
		// both creation paths go through the helper
		const addNewTab = sliceBetween(tabs, 'addNewTab()', 'addHomeTab()');
		assert.match(addNewTab, /nextUntitledTitle\(/);
	});
});

describe('background edit-only tab position', () => {
	test('a percentage is not invented to go with the anchor', () => {
		// The view state carries `scrollTop` but neither height, so no fraction of
		// the scrollable range can be computed from it. `anchorLine` is the first
		// entry of both restore cascades, so recovering it is what decides where the
		// tab opens; writing a percentage nobody can justify is not.
		const source = readSource('src/lib/utils/editorPosition.ts');
		const derivation = sliceFrom(source, 'export function outgoingTabAnchorLine');
		assert.doesNotMatch(derivation, /scrollPercentage/);
	});
});

describe('editor reading position flush', () => {
	const editor = readSource('src/lib/components/Editor.svelte');

	test('the editor derives the anchor in exactly one place', () => {
		// The teardown used to build it inline. A flush that built its own would be
		// a second crossing of the same two numberings, which is the defect shape
		// `lineCoordinates.ts` exists to prevent.
		assert.doesNotMatch(editor, /tabAnchorForEditorTopLine/);
		assert.equal((editor.match(/editorReadingPosition\(/g) ?? []).length, 1);
	});

	test('the flush refuses a tab the editor is not holding', () => {
		// One Editor per window, swapping models between tabs: an unguarded flush
		// would copy the active tab's position onto the record the caller named.
		const flush = sliceFrom(editor, 'export function flushPositionTo');
		assert.match(flush, /if \(!editorReady \|\| !editor \|\| currentTabId !== tabId\) return;/);
	});

	test('a sync asked for while Monaco is loading is kept, and spent after the restore', () => {
		// #799: Ctrl+E from the preview asks before the editor exists. Dropping the
		// request left the editor wherever its old view state put it.
		const sync = sliceFrom(editor, 'export function syncScrollToPosition');
		assert.match(sync, /if \(!editorReady \|\| !editor\) \{\s*pendingSync = position;/);
		const readyAt = offsetOf(editor, 'editorReady = true;');
		const spendAt = offsetOf(editor, 'if (pendingSync) {');
		const revealAt = offsetOf(editor, 'if (pendingReveal) {');
		assert.ok(readyAt < spendAt && spendAt < revealAt);
	});
});
