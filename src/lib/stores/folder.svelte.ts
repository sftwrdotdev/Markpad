import { invoke } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { writeStoredSetting } from './settings.svelte.js';

/** One child of a folder, as `read_folder_entries` lists it. */
export interface FolderEntry {
	name: string;
	path: string;
	isDir: boolean;
}

/** The last folder this install had open, so a restart comes back to it. */
export const LAST_FOLDER_KEY = 'folder.lastRoot';

/**
 * The folder open in this window's sidebar.
 *
 * Holds only what the reader has looked at: the root's children and those of
 * each folder they expanded. Each of those folders is watched (one level,
 * non-recursive) while it is expanded, and a `folder-changed` event re-reads
 * that one listing. Collapsing a folder stops its watch and forgets its
 * listing, so the cost of the sidebar is the part of the tree on screen.
 */
export class FolderManager {
	root = $state<string | null>(null);
	expanded = $state<string[]>([]);
	entries = $state<Record<string, FolderEntry[]>>({});
	error = $state<string | null>(null);

	#unlisten: UnlistenFn | null = null;

	rootName = $derived(this.root ? folderName(this.root) : '');

	async open(path: string) {
		await this.close();
		this.root = path;
		this.error = null;
		// Storage can be unavailable; the folder still opens for this session.
		writeStoredSetting(LAST_FOLDER_KEY, path);
		this.#unlisten ??= await getCurrentWindow().listen<string>('folder-changed', (event) => {
			if (this.isLoaded(event.payload)) void this.#read(event.payload);
		});
		await this.#load(path);
	}

	async close() {
		if (this.root === null) return;
		this.root = null;
		this.expanded = [];
		this.entries = {};
		this.error = null;
		writeStoredSetting(LAST_FOLDER_KEY, null);
		await invoke('unwatch_all_folders').catch(console.error);
	}

	/** Reopens the folder from the last session, if it is still there. */
	async restore() {
		let saved: string | null = null;
		try {
			saved = localStorage.getItem(LAST_FOLDER_KEY);
		} catch {
			return;
		}
		if (!saved) return;
		await this.open(saved);
		// A folder deleted or unmounted since: drop it rather than show an error on launch.
		if (this.error) await this.close();
	}

	isExpanded(path: string): boolean {
		return this.expanded.includes(path);
	}

	isLoaded(path: string): boolean {
		return path in this.entries;
	}

	async toggle(path: string) {
		if (this.isExpanded(path)) {
			this.#collapse(path);
			return;
		}
		this.expanded = [...this.expanded, path];
		await this.#load(path);
	}

	/** Forgets `path` and every folder expanded under it, and stops watching them. */
	#collapse(path: string) {
		this.expanded = this.expanded.filter((p) => p !== path && !isInside(p, path));
		const kept: Record<string, FolderEntry[]> = {};
		for (const [dir, list] of Object.entries(this.entries)) {
			if (dir === path || isInside(dir, path)) {
				invoke('unwatch_folder', { path: dir }).catch(console.error);
			} else {
				kept[dir] = list;
			}
		}
		this.entries = kept;
	}

	/** Re-reads every listing on screen, for the Refresh button. */
	async refresh() {
		await Promise.all(Object.keys(this.entries).map((dir) => this.#read(dir)));
	}

	async #load(path: string) {
		await this.#read(path);
		if (this.isLoaded(path)) await invoke('watch_folder', { path }).catch(console.error);
	}

	async #read(path: string) {
		try {
			const list = await invoke<FolderEntry[]>('read_folder_entries', { path });
			// The folder may have been collapsed or closed while the read was in flight.
			if (path !== this.root && !this.isExpanded(path)) return;
			this.entries = { ...this.entries, [path]: list };
			if (path === this.root) this.error = null;
		} catch (error) {
			if (path === this.root) {
				this.error = String(error);
			} else {
				// A subfolder that vanished collapses; its parent's listing drops it on the next event.
				this.#collapse(path);
			}
		}
	}
}

/** The last component of a path, with either separator. */
export function folderName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, '');
	const name = trimmed.split(/[\\/]/).pop();
	return name || trimmed || path;
}

/** Whether `path` lies under `folder`, on either separator. */
export function isInside(path: string, folder: string): boolean {
	const base = folder.replace(/[\\/]+$/, '');
	return path.length > base.length && path.startsWith(base) && (path[base.length] === '/' || path[base.length] === '\\');
}

export const folderManager = new FolderManager();
