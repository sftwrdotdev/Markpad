import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.js';

const dialog = readSource('src/lib/components/UpdateDialog.svelte');
const globalStyles = readSource('src/styles.css');

test('release notes can be selected even though the app disables selection', () => {
	// The app root sets `user-select: none` on purpose. Anything that holds text
	// a user has to copy out has to say so for itself — nothing else in this
	// component does, so a rule that quietly went missing here would look like
	// no rule at all, which is what #532 reported.
	assert.match(globalStyles, /user-select: none/);

	const notesRule = /\.notes pre \{[^}]*\}/.exec(dialog)?.[0];
	assert.ok(notesRule, 'the release-notes block must still have its own style rule');
	assert.match(notesRule, /user-select: text/);
	assert.match(notesRule, /-webkit-user-select: text/);
});

test('the dialog promises reopened tabs only when restore is on', () => {
	// With "Restore windows on launch" off nothing writes the snapshot, so the
	// relaunched app opens empty and must not have been told otherwise.
	assert.match(dialog, /\{#if settings\.restoreStateOnReopen\}<p>\{tk\('reopensTabs'\)\}<\/p>\{\/if\}/);
});
