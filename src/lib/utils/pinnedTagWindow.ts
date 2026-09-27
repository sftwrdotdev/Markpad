import { invoke } from '@tauri-apps/api/core';

import type { ViewerWindowEntry } from './viewerWindows.js';

/**
 * A new window learns which pinned group to open from its own label.
 * `create_transfer_window` builds `window-<token>`, and a label only takes
 * `[A-Za-z0-9-/:_]`, so the tag name travels hex-encoded. The trailing nonce
 * keeps labels unique when the same group is opened again later.
 */
export function pinnedWindowToken(name: string, nonce: number): string {
	const hex = Array.from(new TextEncoder().encode(name), (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `pinned-${hex}-${nonce}`;
}

export function pinnedTagFromWindowLabel(label: string): string | null {
	const hex = /^window-pinned-((?:[0-9a-f]{2})+)-\d+$/.exec(label)?.[1];
	if (hex === undefined) return null;
	return new TextDecoder().decode(Uint8Array.from(hex.match(/../g)!, (pair) => parseInt(pair, 16)));
}

/** The window already holding `name` as its tag, other than `self`. */
export async function pinnedTagHolder(name: string, self?: string): Promise<string | undefined> {
	const windows = await invoke<ViewerWindowEntry[]>('list_viewer_windows');
	return windows.find((window) => window.tag_name === name && window.label !== self)?.label;
}

export async function openPinnedTagWindow(name: string): Promise<void> {
	const holder = await pinnedTagHolder(name);
	if (holder) await invoke('focus_window', { label: holder });
	else await invoke('create_transfer_window', { token: pinnedWindowToken(name, Date.now()) });
}
