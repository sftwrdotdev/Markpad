import { invoke } from '@tauri-apps/api/core';
import { tabManager } from './tabs.svelte.js';
import { settings } from './settings.svelte.js';
import { t } from '../utils/i18n.js';
import { hasRealFilePath } from '../utils/tabFileActions.js';

export const TAG_COLORS = ['#5f6368', '#1a73e8', '#d93025', '#f9ab00', '#188038', '#d01884', '#a142f4', '#007b83'];

type WindowTag = { name: string; color: string; pinned: boolean };

/** What the tag strip draws: one line under the whole strip, in the tag's colour. */
export function scopeLine(tag: WindowTag | null): { tagged: boolean; color: string | undefined } {
	return { tagged: tag !== null, color: tag?.color };
}

/**
 * The title bar's four popovers — Home, theme, kebab and the window-tag editor —
 * and the window-level dismissal they share.
 */
export class TitleBarPopovers {
	themeMenuOpen = $state(false);
	kebabMenuOpen = $state(false);
	homeMenuOpen = $state(false);
	tagEditorOpen = $state(false);
	tagDraftName = $state('');
	tagDraftColor = $state(TAG_COLORS[1]);
	tagError = $state('');

	get anyOpen(): boolean {
		return this.themeMenuOpen || this.kebabMenuOpen || this.homeMenuOpen || this.tagEditorOpen;
	}

	/**
	 * The controls the popover offers for the stored tag, or null on a window
	 * with none: Pin/Unpin and Remove act on a stored tag. Only a pinned tag can
	 * be closed: closing saves the pin and Home reopens it. An unpinned tag would
	 * be gone for good, which is Remove Tag's job.
	 */
	get tagActions(): { pinned: boolean; canClose: boolean } | null {
		const tag = tabManager.windowTag;
		if (!tag) return null;
		return { pinned: tag.pinned, canClose: tag.pinned };
	}

	openTagEditor() {
		this.tagDraftName = tabManager.windowTag?.name ?? '';
		this.tagDraftColor = tabManager.windowTag?.color ?? TAG_COLORS[1];
		this.tagError = '';
		this.tagEditorOpen = true;
	}

	/**
	 * Whether a *different* live window already carries this name.
	 *
	 * Asked here — when the popover commits, the moment the user names the window — and
	 * nowhere else. In particular not at session restore: a snapshot written by
	 * an older build can legitimately contain two windows under one name, and
	 * refusing it there would clear a tag the user set, silently, at a moment
	 * they are not even looking at the popover. Leaving a restored duplicate
	 * alone costs at most a confusing pair of chips; rejecting it costs state
	 * the user cannot get back.
	 *
	 * A backend that cannot answer means the user's own save goes through. The
	 * check exists to stop one window from quietly overwriting another's pinned
	 * documents, and an IPC failure is not evidence that it would.
	 */
	private async tagNameTakenElsewhere(name: string): Promise<boolean> {
		try {
			return (await invoke('is_window_tag_taken', { name })) === true;
		} catch (error) {
			console.error('Failed to check window tag exclusivity', error);
			return false;
		}
	}

	/**
	 * Commit the draft and close. There is no Save button: Enter, a click
	 * elsewhere and the chip all land here, so leaving the popover is what
	 * saves it. Escape is the one exit that discards.
	 *
	 * An empty name keeps the stored tag. Clearing the field used to remove
	 * the tag, which was harmless behind an explicit Save but would make a
	 * stray click outside a way to delete a pinned session. Remove Tag is the
	 * only exit that removes a tag.
	 */
	async applyTag() {
		const name = this.tagDraftName.trim();
		const tag = tabManager.windowTag;
		if (!name || (tag && name === tag.name && this.tagDraftColor === tag.color)) {
			this.tagEditorOpen = false;
			this.tagError = '';
			return;
		}
		if (await this.tagNameTakenElsewhere(name)) {
			// Refused in place, with the popover still open on the name that was
			// refused: this is a correction the user makes in the field they are
			// already in, not news to be delivered somewhere else.
			this.tagError = t('menu.windowTagTaken', settings.language);
			return;
		}
		let pinned = tag?.pinned;
		// The closing save refreshes the pin by the window's current name, so a
		// rename has to reach the pin file first or the window unpins at close.
		// A colour change needs nothing here: the closing save carries it.
		if (tag?.pinned && name !== tag.name) {
			const renamed = await invoke('rename_pinned_tag', { oldName: tag.name, name, color: this.tagDraftColor }).catch((error) => {
				console.error('Failed to rename the pinned tag', error);
				return 'failed';
			});
			if (renamed === 'taken') {
				this.tagError = t('menu.pinnedTagTaken', settings.language);
				return;
			}
			pinned = renamed === 'renamed';
		}
		tabManager.setWindowTag({ name, color: this.tagDraftColor, pinned });
		this.tagEditorOpen = false;
		this.tagError = '';
	}

	/**
	 * Left-click the chip: a toggle. `stopPropagation` because the window
	 * `click` listener is `dismiss`, and would otherwise dismiss the popover this
	 * just opened.
	 */
	toggleTagEditor(event: Event) {
		event.stopPropagation();
		if (this.tagEditorOpen) this.applyTag();
		else this.openTagEditor();
	}

	/**
	 * Right-click the chip: the same popover left-click opens.
	 *
	 * The chip borrows Chrome's tab-group chip visually, but not the state that
	 * makes Chrome's left/right division necessary. There, left-click collapses
	 * and expands the group, so the commands need somewhere else to live. A
	 * window tag has nothing to collapse — it scopes the whole window — so
	 * left-click has no second job, and putting Pin/Remove behind a right-click
	 * would only hide them behind a gesture with no affordance advertising it.
	 * The one thing right-click does owe the user is not raising the platform
	 * menu over the title bar, hence `preventDefault`.
	 *
	 * It opens but never closes, unlike the left-click toggle. `openTagEditor`
	 * re-seeds the draft from the stored tag, so re-opening an open popover
	 * would throw away a name the user is in the middle of typing; and a
	 * gesture whose whole purpose is "show me the tag's controls" should not
	 * sometimes hide them. `stopPropagation` for the same reason the chip's
	 * left-click has one: `dismiss` is wired to window `contextmenu`, and would
	 * otherwise dismiss the popover this just opened.
	 */
	openTagEditorFromContextMenu(event: Event) {
		event.preventDefault();
		event.stopPropagation();
		if (!this.tagEditorOpen) this.openTagEditor();
	}

	/**
	 * Home > Set window tag. It calls no `stopPropagation` of its own while the
	 * open Home menu has already installed the window listener: the menu
	 * container's `containClick` keeps this click from reaching it.
	 */
	openTagEditorFromHomeMenu() {
		this.homeMenuOpen = false;
		this.openTagEditor();
	}

	editorKeydown(event: { key: string }) {
		if (event.key === 'Escape') this.tagEditorOpen = false;
		else if (event.key === 'Enter') this.applyTag();
	}

	nameEdited() {
		this.tagError = '';
	}

	clearTag() {
		const tag = tabManager.windowTag;
		if (tag?.pinned) invoke('remove_pinned_tag', { name: tag.name }).catch(console.error);
		tabManager.setWindowTag(null);
		this.tagEditorOpen = false;
	}

	async togglePinnedTag() {
		const tag = tabManager.windowTag;
		if (!tag) return;
		if (tag.pinned) {
			invoke('remove_pinned_tag', { name: tag.name }).catch(console.error);
			tabManager.setWindowTag({ ...tag, pinned: false });
			return;
		}
		const files = tabManager.tabs.filter((tab) => hasRealFilePath(tab.path)).map((tab) => tab.path);
		// A pinned group whose window is closed still holds its name, and
		// pinning over it would replace its files. Refused the way a rename is.
		const created = await invoke('save_pinned_tag', { name: tag.name, color: tag.color, files }).catch(console.error);
		if (created === false) {
			this.tagError = t('menu.pinnedTagTaken', settings.language);
			return;
		}
		tabManager.setWindowTag({ ...tag, pinned: true });
	}

	/** Closes every menu; the tag editor commits its draft on the way out. */
	dismiss = () => {
		this.themeMenuOpen = false;
		this.kebabMenuOpen = false;
		this.homeMenuOpen = false;
		if (this.tagEditorOpen) this.applyTag();
	};

	/**
	 * Run inside an `$effect`: while any popover is open, a click, a context
	 * menu or the window losing focus dismisses it. The returned teardown takes
	 * the listeners off again.
	 */
	listenForDismiss(target: EventTarget): () => void {
		const types = ['click', 'contextmenu', 'blur'];
		if (this.anyOpen) for (const type of types) target.addEventListener(type, this.dismiss);
		return () => {
			for (const type of types) target.removeEventListener(type, this.dismiss);
		};
	}
}

/**
 * A popover's own clicks stay inside it: without this, picking a colour in the
 * tag editor, or an item in the Home menu, would reach the window listener and
 * dismiss the popover it was made in.
 */
export function containClick(event: Event) {
	event.stopPropagation();
}
