<script lang="ts">
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { invoke } from '@tauri-apps/api/core';
	import { openUrl } from '@tauri-apps/plugin-opener';
	import { fly, slide } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import iconUrl from '../../assets/icon.png';
	import TabList from './TabList.svelte';
	import { tabManager } from '../stores/tabs.svelte.js';
	import { settings } from '../stores/settings.svelte.js';
	import { t } from '../utils/i18n.js';
	import { getConfiguredTitlebarToolbarIds } from '../utils/titlebarToolbar.js';
	import { modifierFor, shortcutLabel } from '../utils/shortcuts.js';
	import { platformOf } from '../utils/platform.js';
	import { hasMarkdownLinkExtension } from '../utils/markdownLinks.js';
	import { hasExportableDocument, hasRealFilePath } from '../utils/tabFileActions.js';
	import { getVersion } from '@tauri-apps/api/app';

	let currentLanguage = $state(settings.language);

	$effect(() => {
		currentLanguage = settings.language;
	});

	let {
		isFocused,
		isScrolled,
		currentFile,
		liveMode,

		windowTitle,
		showHome,
		onselectFile,
		onnewFile,
		onopenFile,
		onmergeAllWindows,
		onsaveFile,
		onsaveFileAs,
		onreloadFromDisk,
		onexportHtml,
		onexportPdf,
		onexit,
		ontoggleHome,
		ononpenFileLocation,
		ontoggleLiveMode,
		onback,
		onforward,
		canGoBack = false,
		canGoForward = false,

		ontoggleEdit,
		ontoggleEditorToolbar,
		ontoggleSplit,
		isEditing,
		ondetach,
		ontabclick,
		zoomLevel,
		onresetZoom,
		oncloseTab,
		isScrollSynced,
		ontoggleSync,
		isFullWidth,
		ontoggleFullWidth,
		theme = 'system',
		onSetTheme,
		onopenSettings,
		onfind,
	} = $props<{
		isFocused: boolean;
		isScrolled: boolean;
		currentFile: string;
		liveMode: boolean;

		windowTitle: string;
		showHome: boolean;
		onselectFile?: () => void;
		onnewFile?: () => void;
		onopenFile?: () => void;
		onmergeAllWindows?: () => void;
		onsaveFile?: () => void;
		onsaveFileAs?: () => void;
		onreloadFromDisk?: () => void;
		onexportHtml?: () => void;
		onexportPdf?: () => void;
		onexit?: () => void;
		ontoggleHome: () => void;
		ononpenFileLocation: () => void;
		ontoggleLiveMode: () => void;
		onback?: () => void;
		onforward?: () => void;
		canGoBack?: boolean;
		canGoForward?: boolean;

		ontoggleEdit: () => void;
		ontoggleEditorToolbar?: () => void;
		ontoggleSplit?: () => void;
		isEditing: boolean;
		ondetach: (tabId: string) => void;
		ontabclick?: () => void;
		zoomLevel?: number;
		onresetZoom?: () => void;

		oncloseTab?: (id: string) => void;
		isScrollSynced?: boolean;
		ontoggleSync?: () => void;

		isFullWidth?: boolean;
		ontoggleFullWidth?: () => void;
		theme?: string;
		onSetTheme?: (theme: string) => void;
		onopenSettings?: () => void;
		onfind?: () => void;
	}>();

	const appWindow = getCurrentWindow();

	let innerWidth = $state(1000);
	let isCollapsed = $derived(innerWidth <= 450 || settings.zenMode);

	const DEBUG_MACOS = false;

	// The platform comes from `settings.osType` — the Rust `get_os_type` answer
	// the rest of the app already reads — rather than from this component's own
	// user-agent sniff for "Macintosh", which was a second source that could
	// disagree with it. `platformOf` covers the window before that
	// command answers; see the comment on it for why the title bar cannot simply
	// read `settings.osType` directly without flashing Windows chrome on a Mac.
	//
	// `$derived` rather than plain consts: the source is now reactive state, and
	// `osType` can change once after mount (unknown → resolved). At plain consts
	// the title bar would keep whatever the fallback said and never correct
	// itself on a machine where the two do differ.
	let platform = $derived(DEBUG_MACOS ? 'macos' : platformOf(settings.osType));
	let isMac = $derived(platform === 'macos');
	let useNativeMacChrome = $derived(isMac && !DEBUG_MACOS);
	let modifier = $derived(modifierFor(platform));

	let isWin11 = $state(false);
	const tagColors = ['#5f6368', '#1a73e8', '#d93025', '#f9ab00', '#188038', '#d01884', '#a142f4', '#007b83'];
	let tagEditorOpen = $state(false);
	let tagDraftName = $state('');
	let tagDraftColor = $state(tagColors[1]);
	let tagError = $state('');

	function openTagEditor() {
		tagDraftName = tabManager.windowTag?.name ?? '';
		tagDraftColor = tabManager.windowTag?.color ?? tagColors[1];
		tagError = '';
		tagEditorOpen = true;
	}

	/**
	 * Whether a *different* live window already carries this name.
	 *
	 * Asked here — at Save/Enter, the moment the user names the window — and
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
	async function tagNameTakenElsewhere(name: string): Promise<boolean> {
		try {
			return (await invoke('is_window_tag_taken', { name })) === true;
		} catch (error) {
			console.error('Failed to check window tag exclusivity', error);
			return false;
		}
	}

	async function applyTag() {
		const name = tagDraftName.trim();
		if (!name) {
			// The same exit as Remove Tag, not a second one. This branch used to
			// call `setWindowTag(null)` on its own, which drops the tag from the
			// window but leaves its entry in `pinned-tags.json` — so a cleared
			// PINNED tag went on offering itself from the Home screen as a saved
			// session under a name no window held any more. `clearTag` is the
			// path that already unpins first.
			clearTag();
			tagError = '';
			return;
		}
		if (await tagNameTakenElsewhere(name)) {
			// Refused in place, with the popover still open on the name that was
			// refused: this is a correction the user makes in the field they are
			// already in, not news to be delivered somewhere else.
			tagError = t('menu.windowTagTaken', currentLanguage);
			return;
		}
		tabManager.setWindowTag({ name, color: tagDraftColor, pinned: tabManager.windowTag?.pinned });
		tagEditorOpen = false;
		tagError = '';
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
	 * left-click has one: `handleGlobalDismiss` is wired to window
	 * `contextmenu`, and would otherwise dismiss the popover this just opened.
	 */
	function openTagEditorFromContextMenu(event: MouseEvent) {
		event.preventDefault();
		event.stopPropagation();
		if (!tagEditorOpen) openTagEditor();
	}

	function clearTag() {
		const tag = tabManager.windowTag;
		if (tag?.pinned) invoke('remove_pinned_tag', { name: tag.name }).catch(console.error);
		tabManager.setWindowTag(null);
		tagEditorOpen = false;
	}

	function togglePinnedTag() {
		const tag = tabManager.windowTag;
		if (!tag) return;
		if (tag.pinned) {
			invoke('remove_pinned_tag', { name: tag.name }).catch(console.error);
			tabManager.setWindowTag({ ...tag, pinned: false });
			return;
		}
		const files = tabManager.tabs.filter((tab) => hasRealFilePath(tab.path)).map((tab) => tab.path);
		invoke('save_pinned_tag', { name: tag.name, color: tag.color, files }).catch(console.error);
		tabManager.setWindowTag({ ...tag, pinned: true });
	}

	$effect(() => {
		invoke('is_win11')
			.then((res) => {
				isWin11 = res as boolean;
			})
			.catch(() => {
				isWin11 = false;
			});
	});

	let tooltip = $state({
		visible: false,
		text: '',
		shortcut: '',
		x: 0,
		y: 0,
		align: 'center' as 'left' | 'center' | 'right',
	});

	function showTooltip(e: MouseEvent, text: string, shortcut: string | undefined = '', force: boolean = false) {
		if (!force && (kebabMenuOpen || homeMenuOpen)) return;
		const target = e.currentTarget as HTMLElement;
		const rect = target.getBoundingClientRect();
		const windowWidth = window.innerWidth;
		const edgeThreshold = 100;

		tooltip.text = text;
		// A COMPLETE chord, from the registry — not a suffix this function
		// prefixes with the modifier. Composing it here is what made the
		// Reload-from-Disk tooltip read "Ctrl+F5" for a binding that is plain F5.
		tooltip.shortcut = shortcut ?? '';

		if (rect.left < edgeThreshold) {
			tooltip.align = 'left';
			tooltip.x = rect.left;
		} else if (rect.right > windowWidth - edgeThreshold) {
			tooltip.align = 'right';
			tooltip.x = rect.right;
		} else {
			tooltip.align = 'center';
			tooltip.x = rect.left + rect.width / 2;
		}

		tooltip.y = rect.bottom + 8;
		tooltip.visible = true;
	}

	function hideTooltip() {
		tooltip.visible = false;
	}

	let zoomTimeout: ReturnType<typeof setTimeout>;
	let isInitialZoomLoad = true;

	$effect(() => {
		if (zoomLevel !== undefined) {
			if (isInitialZoomLoad) {
				isInitialZoomLoad = false;
				return;
			}

			const kebabBtn = document.querySelector('.kebab-btn') as HTMLElement;
			if (kebabBtn && !kebabMenuOpen && !homeMenuOpen && !themeMenuOpen) {
				const rect = kebabBtn.getBoundingClientRect();
				tooltip.text = `${zoomLevel}%`;
				tooltip.shortcut = '';
				tooltip.align = 'right';
				tooltip.x = rect.right;
				tooltip.y = rect.bottom + 8;
				tooltip.visible = true;

				clearTimeout(zoomTimeout);
				zoomTimeout = setTimeout(() => {
					if (tooltip.text === `${zoomLevel}%`) {
						tooltip.visible = false;
					}
				}, 1500);
			}
		}
	});

	let visibleActionIds = $derived.by(() => {
		const list: string[] = [];

		if (tabManager.activeTab && !showHome) {
			list.push('back');
			list.push('forward');
			if (currentFile) list.push('reload');

			// An unsaved buffer has no name to read an extension off, and is
			// treated as Markdown — which is what the old inline default of `'md'`
			// said, spelled as the condition it actually is.
			const isMarkdown = currentFile ? hasMarkdownLinkExtension(currentFile) : true;

			if (isMarkdown) {
				list.push('toc');
				list.push('fullWidth');
				if (!tabManager.activeTab?.isSplit && !isEditing && currentFile) {
					list.push('live');
				}
				if (tabManager.activeTab?.isSplit) {
					list.push('sync');
				}
				list.push('split');
			}
			if (isMarkdown && !tabManager.activeTab?.isSplit) {
				list.push('edit');
			}
			// Find in preview: only meaningful when a preview is actually
			// visible (view mode or split). In pure edit mode Monaco's own
			// Ctrl+F handles search, so we hide the entry there.
			if (isMarkdown && (!isEditing || tabManager.activeTab?.isSplit)) {
				list.push('find');
			}
			if (isEditing || tabManager.activeTab?.isSplit) {
				list.push('editorToolbar');
			}
			list.push('zen');
			list.push('tabs');
		}

		if (zoomLevel && zoomLevel !== 100) list.push('zoom');
		list.push('theme');
		list.push('settings');

		return list;
	});

	let configuredActionIds = $derived.by(() =>
		getConfiguredTitlebarToolbarIds(
			visibleActionIds,
			settings.titlebarToolbarOrder,
			settings.titlebarToolbarHidden,
			settings.titlebarToolbarPlacement,
		),
	);

	let themeMenuOpen = $state(false);
	let kebabMenuOpen = $state(false);
	let homeMenuOpen = $state(false);
	let appVersion = $state('');
	let savedVscodeThemes = $state<string[]>([]);
	
	$effect(() => {
		if (themeMenuOpen) {
			invoke('get_saved_vscode_themes')
				.then((themes) => {
					savedVscodeThemes = themes as string[];
				})
				.catch(console.error);
		}
	});

	$effect(() => {
		getVersion()
			.then((v) => {
				appVersion = v;
			})
			.catch(console.error);
	});

	function handleSetTheme(t: string) {
		if (onSetTheme) onSetTheme(t);
		themeMenuOpen = false;
	}

	function handleGlobalDismiss() {
		themeMenuOpen = false;
		kebabMenuOpen = false;
		homeMenuOpen = false;
		// The tag editor is dismissed here rather than committed: `applyTag` is
		// what writes a tag, and it is reached only from Save or Enter. The
		// draft is not preserved, because `openTagEditor` re-seeds it from the
		// stored tag on every open.
		tagEditorOpen = false;
	}

	$effect(() => {
		if (themeMenuOpen || kebabMenuOpen || homeMenuOpen || tagEditorOpen) {
			window.addEventListener('click', handleGlobalDismiss);
			window.addEventListener('contextmenu', handleGlobalDismiss);
			window.addEventListener('blur', handleGlobalDismiss);
		}
		return () => {
			window.removeEventListener('click', handleGlobalDismiss);
			window.removeEventListener('contextmenu', handleGlobalDismiss);
			window.removeEventListener('blur', handleGlobalDismiss);
		};
	});
</script>

<svelte:window bind:innerWidth />

<div class="custom-title-bar {isScrolled ? 'scrolled' : ''} {!isMac ? 'windows' : ''} {useNativeMacChrome ? 'native-mac' : ''}">
	{#if !isMac && !isWin11}
		<div class="window-top-border"></div>
	{/if}
	<div class="window-controls-left" data-tauri-drag-region>
		{#if isMac && !useNativeMacChrome}
			<div class="macos-traffic-lights" class:visible={isMac}>
				<button class="mac-btn mac-close" onclick={() => appWindow.close()} aria-label={t('common.close', currentLanguage)}>
						<svg width="6" height="6" viewBox="0 0 6 6" class="mac-icon"
								><path d="M0.5 0.5L5.5 5.5M5.5 0.5L0.5 5.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" /></svg>
					</button>
					<button class="mac-btn mac-minimize" onclick={() => appWindow.minimize()} aria-label={t('common.minimize', currentLanguage)}>
						<svg width="6" height="6" viewBox="0 0 6 6" class="mac-icon"><path d="M0.5 3H5.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" /></svg>
					</button>
					<button class="mac-btn mac-maximize" onclick={() => appWindow.toggleMaximize()} aria-label={t('common.maximize', currentLanguage)}>
						<svg width="6" height="6" viewBox="0 0 6 6" class="mac-icon"><path d="M0.5 3H5.5M3 0.5V5.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" /></svg>
					</button>
			</div>
		{/if}
		<div class="home-menu-container" role="presentation">
			<button
				class="icon-home-btn {showHome || homeMenuOpen ? 'active' : ''}"
				onclick={(e) => {
					e.stopPropagation();
					homeMenuOpen = !homeMenuOpen;
					if (homeMenuOpen) {
						themeMenuOpen = false;
						kebabMenuOpen = false;
						hideTooltip();
					}
				}}
				aria-label={t('tooltip.menu', currentLanguage)}
			onmouseenter={(e) => {
							if (!homeMenuOpen) showTooltip(e, t('tooltip.menu', currentLanguage));
						}}
				onmousedown={(e) => e.preventDefault()}
				onmouseleave={hideTooltip}>
				<img
					src={iconUrl}
					alt="icon"
					class="window-icon"
					style:filter={theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'none' : 'invert(0.7)'} />
			</button>
			{#if homeMenuOpen}
				<div
					class="home-dropdown-menu"
					role="menu"
					tabindex="-1"
					transition:fly={{ y: 5, duration: 150 }}
					onclick={(e) => e.stopPropagation()}
					onkeydown={(e) => {
						if (e.key === 'Escape') homeMenuOpen = false;
					}}>
					<button
				class="home-menu-item"
				onclick={() => {
					homeMenuOpen = false;
					ontoggleHome();
				}}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
					><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>
				{t('menu.home', currentLanguage)}
			</button>
					<button
				class="home-menu-item"
				onclick={() => {
					homeMenuOpen = false;
					onnewFile?.();
				}}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
					><path d="M14 2H6a2 2 0 0 0-2 2v16h16V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line
						x1="9"
						y1="15"
						x2="15"
						y2="15"></line
					></svg>
				{t('menu.newFile', currentLanguage)}
				<span class="menu-shortcut">{shortcutLabel('file-new', modifier)}</span>
			</button>
			<button
				class="home-menu-item"
				onclick={() => {
					homeMenuOpen = false;
					onopenFile?.();
				}}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
					><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><polyline points="15 13 18 13 18 10"></polyline><line
						x1="14"
						y1="14"
						x2="18"
						y2="10"></line
					></svg>
				{t('menu.openFile', currentLanguage)}
				<span class="menu-shortcut">{shortcutLabel('file-open', modifier)}</span>
			</button>
					{#if currentFile !== '' || (tabManager.activeTab && tabManager.activeTab.isEditing)}
						<button
						class="home-menu-item"
						onclick={() => {
							homeMenuOpen = false;
							onsaveFile?.();
						}}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline
								points="7 3 7 8 15 8"></polyline
							></svg>
						{t('menu.save', currentLanguage)}
						<span class="menu-shortcut">{shortcutLabel('file-save', modifier)}</span>
					</button>
					<button
						class="home-menu-item"
						onclick={() => {
							homeMenuOpen = false;
							onsaveFileAs?.();
						}}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline
								points="7 3 7 8 15 8"></polyline
							></svg>
						{t('menu.saveAs', currentLanguage)}
						<span class="menu-shortcut">{shortcutLabel('file-save-as', modifier)}</span>
					</button>
					{#if currentFile !== ''}
						<button
							class="home-menu-item"
							onclick={() => {
								homeMenuOpen = false;
								onreloadFromDisk?.();
							}}>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
								><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15A9 9 0 1 1 18 5.64L23 10"></path></svg>
							{t('menu.reloadFromDisk', currentLanguage)}
							<span class="menu-shortcut">{shortcutLabel('file-reload', modifier)}</span>
						</button>
					{/if}
					{/if}
					<!--
						`rawContent`, not `content`: the exports read the Markdown buffer
						(`exportAsHtml` returns null on an empty `ctx.rawContent`), while
						`content` is the rendered-preview HTML, refreshed only while the
						preview is on screen. In plain edit mode with the TOC closed —
						the default state of a new file — `content` is still empty for a
						buffer that has never been rendered, so gating on it hid an export
						that would have produced a file.
					-->
					{#if hasExportableDocument(currentFile, tabManager.activeTab?.rawContent)}
						<div class="home-menu-divider"></div>
						<button
						class="home-menu-item"
						onclick={() => {
							homeMenuOpen = false;
							onexportHtml?.();
						}}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
						{t('menu.exportHtml', currentLanguage)}
					</button>
					<button
						class="home-menu-item"
						onclick={() => {
							homeMenuOpen = false;
							onexportPdf?.();
						}}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="9" y1="15" x2="15" y2="15"></line></svg>
						{t('menu.exportPdf', currentLanguage)}
						<span class="menu-shortcut">{shortcutLabel('file-export-pdf', modifier)}</span>
					</button>
					{/if}
					<div class="home-menu-divider"></div>
					<button
						class="home-menu-item"
						onclick={() => {
							homeMenuOpen = false;
							openTagEditor();
						}}>
						{t('menu.setWindowTag', currentLanguage)}
					</button>
					<button
						class="home-menu-item"
						onclick={() => {
							homeMenuOpen = false;
							onmergeAllWindows?.();
						}}>
						{t('menu.mergeAllWindows', currentLanguage)}
					</button>
					<div class="home-menu-divider"></div>
					<button
					class="home-menu-item"
					onclick={() => {
						homeMenuOpen = false;
						onexit?.();
					}}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
						><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
					{t('menu.exit', currentLanguage)}
					<span class="menu-shortcut">{shortcutLabel('app-exit', modifier)}</span>
				</button>
					<div class="home-menu-divider"></div>
					<button
						class="home-menu-footer"
						onclick={() => {
							homeMenuOpen = false;
							openUrl('https://github.com/alecdotdev/Markpad')
								.catch(() => window.open('https://github.com/alecdotdev/Markpad', '_blank'));
						}}>
						v{appVersion}
					</button>
				</div>
			{/if}
		</div>
	</div>
	<div class="window-tag-container">
		{#if tabManager.windowTag}
			<button
				class="window-tag-chip"
				style:--tag-color={tabManager.windowTag.color}
				oncontextmenu={openTagEditorFromContextMenu}
				onclick={(event) => {
					event.stopPropagation();
					if (tagEditorOpen) tagEditorOpen = false;
					else openTagEditor();
				}}>
				{tabManager.windowTag.name}
			</button>
		{/if}
		{#if tagEditorOpen}
			<div
				class="tag-editor"
				role="dialog"
				tabindex="-1"
				onclick={(event) => event.stopPropagation()}
				onkeydown={(event) => {
					if (event.key === 'Escape') tagEditorOpen = false;
					else if (event.key === 'Enter') applyTag();
				}}>
				<!-- svelte-ignore a11y_autofocus -->
				<input
					autofocus
					spellcheck="false"
					placeholder={t('menu.windowTagPlaceholder', currentLanguage)}
					bind:value={tagDraftName}
					oninput={() => (tagError = '')} />
				{#if tagError}<p class="tag-error" role="alert">{tagError}</p>{/if}
				<div class="tag-colors">
					{#each tagColors as color}
						<button class:selected={tagDraftColor === color} style:--tag-color={color} onclick={() => (tagDraftColor = color)} aria-label={color}></button>
					{/each}
				</div>
				<button class="tag-save-btn" onclick={applyTag}>{t('settings.save', currentLanguage)}</button>
				{#if tabManager.windowTag}<button class="tag-action-btn" onclick={togglePinnedTag}>{t(tabManager.windowTag.pinned ? 'menu.unpinWindowTag' : 'menu.pinWindowTag', currentLanguage)}</button>{/if}
				{#if tabManager.windowTag}<button class="tag-action-btn danger" onclick={clearTag}>{t('menu.windowTagClear', currentLanguage)}</button>{/if}
			</div>
		{/if}
	</div>

	{#if tabManager.tabs.length > 0 && settings.showTabs}
		<div class="tab-area" class:tagged={tabManager.windowTag !== null} style:--tag-color={tabManager.windowTag?.color}>
			<TabList onnewTab={() => tabManager.addNewTab()} {ondetach} {showHome} {ontabclick} {oncloseTab} />
		</div>
	{:else}
		<div class="window-title-container" data-tauri-drag-region>
			<div class="window-title {isFocused ? 'focused' : 'unfocused'}" data-tauri-drag-region>
				<span class="title-text" data-tauri-drag-region>
					{windowTitle}
				</span>
			</div>
		</div>
	{/if}

	<div class="title-actions-container {isCollapsed ? 'collapsed' : ''}" data-tauri-drag-region>
		{#snippet kebabButton()}
			<button
				class="kebab-btn {kebabMenuOpen ? 'active' : ''}"
				onclick={(e) => {
					e.stopPropagation();
					kebabMenuOpen = !kebabMenuOpen;
					if (kebabMenuOpen) {
						themeMenuOpen = false;
						hideTooltip();
					}
				}}
				onmouseenter={(e) => {
							if (!kebabMenuOpen) showTooltip(e, t('tooltip.more', currentLanguage));
						}}
				onmousedown={(e) => e.preventDefault()}
				onmouseleave={hideTooltip}
				aria-label={t('tooltip.moreActions', currentLanguage)}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="1"></circle>
					<circle cx="12" cy="5" r="1"></circle>
					<circle cx="12" cy="19" r="1"></circle>
				</svg>
			</button>
		{/snippet}

	{#snippet actionItems(ids: string[])}
			{#each ids as id (id)}
				{#if id === 'back'}
					<button
						class="title-action-btn"
						disabled={!canGoBack}
						onclick={() => {
							hideTooltip();
							kebabMenuOpen = false;
							onback?.();
						}}
						aria-label={t('tooltip.back', currentLanguage)}
						onmouseenter={(e) => showTooltip(e, t('tooltip.back', currentLanguage))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}
						transition:fly={{ x: 10, duration: 200 }}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<polyline points="15 18 9 12 15 6"></polyline>
						</svg>
						<span class="action-label">{t('menu.back', currentLanguage)}</span>
						<span class="menu-shortcut">{shortcutLabel('nav-back', modifier)}</span>
					</button>
				{:else if id === 'forward'}
					<button
						class="title-action-btn"
						disabled={!canGoForward}
						onclick={() => {
							hideTooltip();
							kebabMenuOpen = false;
							onforward?.();
						}}
						aria-label={t('tooltip.forward', currentLanguage)}
						onmouseenter={(e) => showTooltip(e, t('tooltip.forward', currentLanguage))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}
						transition:fly={{ x: 10, duration: 200 }}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<polyline points="9 18 15 12 9 6"></polyline>
						</svg>
						<span class="action-label">{t('menu.forward', currentLanguage)}</span>
						<span class="menu-shortcut">{shortcutLabel('nav-forward', modifier)}</span>
					</button>
				{:else if id === 'settings'}
					<button
						class="title-action-btn"
						onclick={() => {
							hideTooltip();
							kebabMenuOpen = false;
							onopenSettings?.();
						}}
						aria-label={t('tooltip.settings', currentLanguage)}
											onmouseenter={(e) => showTooltip(e, t('tooltip.settings', currentLanguage))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}
						transition:fly={{ x: 10, duration: 200 }}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="3"></circle>
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
						</svg>
						<span class="action-label">{t('menu.settings', currentLanguage)}</span>
					</button>
				{:else if id === 'zoom'}
					<button
						class="menu-zoom-item"
						onclick={() => {
							hideTooltip();
							onresetZoom?.();
						}}
						onmousedown={(e) => e.preventDefault()}
						transition:fly={{ y: -10, duration: 150 }}
						aria-label={t('tooltip.resetZoom', currentLanguage)}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="11" cy="11" r="8"></circle>
							<line x1="21" y1="21" x2="16.65" y2="16.65"></line>
							<line x1="11" y1="8" x2="11" y2="14"></line>
							<line x1="8" y1="11" x2="14" y2="11"></line>
						</svg>
						<span class="zoom-value">{zoomLevel}%</span>
						<span class="menu-shortcut">{t('tooltip.reset', currentLanguage)}</span>
					</button>
				{:else if id === 'zen'}
					<button
						class="title-action-btn {settings.zenMode ? 'active' : ''}"
						onclick={() => settings.toggleZenMode()}
						aria-label={t('tooltip.toggleZenMode', currentLanguage)}
											onmouseenter={(e) => showTooltip(e, t('tooltip.zenMode', currentLanguage))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}
						transition:fly={{ x: 10, duration: 200 }}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							{#if settings.zenMode}
								<path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path>
							{:else}
								<circle cx="12" cy="12" r="10"></circle>
								<circle cx="12" cy="12" r="3"></circle>
							{/if}
						</svg>
						<span class="action-label">{t('menu.zenMode', currentLanguage)}</span>
						<span class="menu-shortcut">{shortcutLabel('toggle-zen-mode', modifier)}</span>
					</button>
				{:else if id === 'tabs'}
					<button
						class="title-action-btn"
						style:opacity={settings.zenMode ? 0.3 : 1}
						style:pointer-events={settings.zenMode ? 'none' : 'auto'}
						onclick={() => settings.toggleTabs()}
						aria-label={t('tooltip.tabs', currentLanguage).replace('{{action}}', settings.showTabs ? t('tooltip.hide', currentLanguage) : t('tooltip.show', currentLanguage))}
											onmouseenter={(e) => showTooltip(e, t('tooltip.tabs', currentLanguage).replace('{{action}}', settings.showTabs ? t('tooltip.hide', currentLanguage) : t('tooltip.show', currentLanguage)), shortcutLabel('toggle-tabs', modifier))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}
						transition:fly={{ x: 10, duration: 200 }}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
							<line x1="3" y1="9" x2="21" y2="9"></line>
							<line x1="9" y1="21" x2="9" y2="9"></line>
						</svg>
						<span class="action-label">{t('menu.tabs', currentLanguage).replace('{{action}}', settings.showTabs ? t('menu.hide', currentLanguage) : t('menu.show', currentLanguage) )}</span>
						<span class="menu-shortcut">{shortcutLabel('toggle-tabs', modifier)}</span>
					</button>
				{:else if id === 'find'}
					<button
						class="title-action-btn"
						onclick={() => {
							hideTooltip();
							kebabMenuOpen = false;
							onfind?.();
						}}
						aria-label={t('tooltip.find', currentLanguage)}
											onmouseenter={(e) => showTooltip(e, t('tooltip.find', currentLanguage), shortcutLabel('app-find', modifier))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}
						transition:fly={{ x: 10, duration: 200 }}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="11" cy="11" r="7"></circle>
							<line x1="21" y1="21" x2="16.65" y2="16.65"></line>
						</svg>
						<span class="action-label">{t('menu.find', currentLanguage)}</span>
						<span class="menu-shortcut">{shortcutLabel('app-find', modifier)}</span>
					</button>
				{:else if id === 'open_loc'}
					<button
						class="title-action-btn"
						onclick={ononpenFileLocation}
						aria-label={t('tooltip.openFileLocation', currentLanguage)}
											onmouseenter={(e) => showTooltip(e, t('tooltip.openFileLocation', currentLanguage))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}
						transition:fly={{ x: 10, duration: 200 }}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><polyline points="15 13 18 13 18 10"></polyline><line
								x1="14"
								y1="14"
								x2="18"
								y2="10"></line
							></svg>
						<span class="action-label">{t('menu.openLocation', currentLanguage)}</span>
					</button>
				{:else if id === 'split'}
					<button
						class="title-action-btn {tabManager.activeTab?.isSplit ? 'active' : ''}"
						onclick={() => ontoggleSplit?.()}
						aria-label={t('tooltip.toggleSplitView', currentLanguage)}
											onmouseenter={(e) => showTooltip(e, t('tooltip.splitView', currentLanguage), shortcutLabel('view-toggle-split', modifier))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}
						transition:fly={{ x: 10, duration: 200 }}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line><rect
								x="13"
								y="2"
								width="9"
								height="20"
								rx="2"
								ry="2"
								transform="rotate(0 13 2)"></rect
							></svg>
						<span class="action-label">{t('menu.splitView', currentLanguage)}</span>
						<span class="menu-shortcut">{shortcutLabel('view-toggle-split', modifier)}</span>
					</button>
				{:else if id === 'sync'}
					<button
						class="title-action-btn {isScrollSynced ? 'active' : ''}"
						onclick={() => ontoggleSync?.()}
						aria-label={t('tooltip.toggleScrollSync', currentLanguage)}
											onmouseenter={(e) => showTooltip(e, t('tooltip.scrollSync', currentLanguage))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}
						transition:fly={{ x: 10, duration: 200 }}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
						<span class="action-label">{t('menu.syncScroll', currentLanguage)}</span>
					</button>
				{:else if id === 'fullWidth'}
					<button
						class="title-action-btn {isFullWidth ? 'active' : ''}"
						onclick={() => ontoggleFullWidth?.()}
						aria-label={t('tooltip.toggleFullWidth', currentLanguage)}
											onmouseenter={(e) => showTooltip(e, t('tooltip.fullWidth', currentLanguage))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}
						transition:fly={{ x: 10, duration: 200 }}>
						<svg xmlns="http://www.w3.org/2000/svg" height="14" viewBox="0 -960 960 960" width="14" fill="currentColor"
							><path
								d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160Zm640-560H160v480h640v-480Zm-640 0v480-480Zm200 360v-240L240-480l120 120Zm360-120L600-600v240l120-120Z" /></svg>
						<span class="action-label">{t('menu.fullWidth', currentLanguage)}</span>
					</button>
				{:else if id === 'reload'}
					<button
						class="title-action-btn"
						onclick={() => {
							hideTooltip();
							kebabMenuOpen = false;
							onreloadFromDisk?.();
						}}
						aria-label={t('tooltip.reloadFromDisk', currentLanguage)}
											onmouseenter={(e) => showTooltip(e, t('tooltip.reloadFromDisk', currentLanguage), shortcutLabel('file-reload', modifier))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}
						transition:fly={{ x: 10, duration: 200 }}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15A9 9 0 1 1 18 5.64L23 10"></path></svg>
						<span class="action-label">{t('menu.reloadFromDisk', currentLanguage)}</span>
						<span class="menu-shortcut">{shortcutLabel('file-reload', modifier)}</span>
					</button>
				{:else if id === 'live'}
					<button
						class="title-action-btn {liveMode ? 'active' : ''}"
						onclick={ontoggleLiveMode}
						aria-label={t('tooltip.toggleAutoReload', currentLanguage)}
											onmouseenter={(e) => showTooltip(e, t('tooltip.autoReload', currentLanguage))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path
								d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path
							></svg>
						<span class="action-label">{t('menu.autoReload', currentLanguage)}</span>
					</button>
				{:else if id === 'edit'}
					<button
						class="title-action-btn {isEditing ? 'active' : ''}"
						onclick={ontoggleEdit}
						aria-label={t('tooltip.editFile', currentLanguage)}
											onmouseenter={(e) => showTooltip(e, t('tooltip.editFile', currentLanguage), shortcutLabel('view-toggle-edit', modifier))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>
						<span class="action-label">{t('menu.editor', currentLanguage)}</span>
						<span class="menu-shortcut">{shortcutLabel('view-toggle-edit', modifier)}</span>
					</button>
				{:else if id === 'editorToolbar'}
					<button
						class="title-action-btn {settings.showEditorToolbar ? 'active' : ''}"
						onclick={ontoggleEditorToolbar}
						aria-label={t('tooltip.editorToolbar', currentLanguage)}
						onmouseenter={(e) => showTooltip(e, t('tooltip.editorToolbar', currentLanguage))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/>
						</svg>
						<span class="action-label">{t('settings.editorToolbar', currentLanguage)}</span>
					</button>
				{:else if id === 'theme'}
					<div class="theme-dropdown-container">
						<button
							class="title-action-btn {themeMenuOpen ? 'active' : ''}"
							onclick={(e) => {
								e.stopPropagation();
								themeMenuOpen = !themeMenuOpen;
								if (themeMenuOpen) hideTooltip();
							}}
							aria-label={t('tooltip.changeTheme', currentLanguage)}
														onmouseenter={(e) => {
														if (!themeMenuOpen) showTooltip(e, t('tooltip.changeTheme', currentLanguage));
												}}
							onmousedown={(e) => e.preventDefault()}
							onmouseleave={hideTooltip}
							transition:fly={{ x: 10, duration: 200 }}>
							{#if theme === 'light'}
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
									><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line
										x1="4.22"
										y1="4.22"
										x2="5.64"
										y2="5.64"></line
									><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line
										x1="4.22"
										y1="19.78"
										x2="5.64"
										y2="18.36"></line
									><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
							{:else if theme === 'dark'}
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
									><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
							{:else}
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
									><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
							{/if}
							<span class="action-label">{t('menu.changeTheme', currentLanguage)}</span>
						</button>
						{#if themeMenuOpen}
							<div
								class="theme-menu"
								role="menu"
								tabindex="-1"
								transition:fly={{ y: 5, duration: 150 }}
								onclick={(e) => e.stopPropagation()}
								onkeydown={(e) => {
									if (e.key === 'Escape') themeMenuOpen = false;
								}}>
								<button class="theme-option {theme === 'system' ? 'selected' : ''}" onclick={() => handleSetTheme('system')}> {t('theme.followSystem', currentLanguage)} </button>
								<button class="theme-option {theme === 'light' ? 'selected' : ''}" onclick={() => handleSetTheme('light')}> {t('theme.defaultLight', currentLanguage)} </button>
								<button class="theme-option {theme === 'dark' ? 'selected' : ''}" onclick={() => handleSetTheme('dark')}> {t('theme.defaultDark', currentLanguage)} </button>
								{#if savedVscodeThemes.length > 0}
									<div class="theme-menu-divider"></div>
									{#each savedVscodeThemes as t}
										<button class="theme-option {theme === `vscode:${t}` ? 'selected' : ''}" onclick={() => handleSetTheme(`vscode:${t}`)}>
											{t}
										</button>
									{/each}
								{/if}
							</div>
						{/if}
					</div>
				{/if}
			{/each}
		{/snippet}

		{#if isCollapsed}
			{#if configuredActionIds.visibleIds.length > 0}
				{@render kebabButton()}
				{#if kebabMenuOpen}
					<div
						class="title-actions show-dropdown"
						data-tauri-drag-region
						role="menu"
						tabindex="-1"
						transition:fly={{ y: 5, duration: 150 }}
						onclick={(e) => e.stopPropagation()}
						onkeydown={(e) => {
							if (e.key === 'Escape') kebabMenuOpen = false;
						}}>
						{@render actionItems(configuredActionIds.visibleIds)}
					</div>
				{/if}
			{/if}
		{:else}
			<div class="title-actions inline" data-tauri-drag-region>
				{@render actionItems(configuredActionIds.barIds)}
			</div>

			{#if configuredActionIds.menuIds.length > 0}
				{@render kebabButton()}
				{#if kebabMenuOpen}
					<div
						class="title-actions show-dropdown"
						data-tauri-drag-region
						role="menu"
						tabindex="-1"
						transition:fly={{ y: 5, duration: 150 }}
						onclick={(e) => e.stopPropagation()}
						onkeydown={(e) => {
							if (e.key === 'Escape') kebabMenuOpen = false;
						}}>
						{@render actionItems(configuredActionIds.menuIds)}
					</div>
				{/if}
			{/if}
		{/if}
	</div>

	<div class="window-controls-right" data-tauri-drag-region>
		{#if !isMac}
			<button class="control-btn" onclick={() => appWindow.minimize()} aria-label={t('common.minimize', currentLanguage)}>
				<svg width="12" height="12" viewBox="0 0 12 12"><rect fill="currentColor" width="10" height="1" x="1" y="6" /></svg>
			</button>
			<button class="control-btn" onclick={() => appWindow.toggleMaximize()} aria-label={t('common.maximize', currentLanguage)}>
				<svg width="12" height="12" viewBox="0 0 12 12"><rect fill="none" stroke="currentColor" stroke-width="1" width="9" height="9" x="1.5" y="1.5" /></svg>
			</button>
			<button
				class="control-btn close-btn"
				onclick={() => appWindow.close()}
				aria-label={t('common.close', currentLanguage)}>
				<svg width="12" height="12" viewBox="0 0 12 12"><path fill="currentColor" d="M11 1.7L10.3 1 6 5.3 1.7 1 1 1.7 5.3 6 1 10.3 1.7 11 6 6.7 10.3 11 11 10.3 6.7 6z" /></svg>
			</button>
		{/if}
	</div>
</div>

<div class="custom-tooltip {tooltip.visible ? 'visible' : ''} align-{tooltip.align}" style="left: {tooltip.x}px; top: {tooltip.y}px;">
	<span class="tooltip-text">{tooltip.text}</span>
	{#if tooltip.shortcut}
		<span class="tooltip-shortcut">{tooltip.shortcut}</span>
	{/if}
</div>

<style>
	.custom-title-bar {
		height: 36px;
		background-color: var(--color-canvas-default);
		display: flex;
		justify-content: space-between;
		align-items: center;
		user-select: none;
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		z-index: 9999;
		font-family: var(--win-font);
		border-bottom: 1px solid transparent;
		transition: border-color 0.2s;
	}

	.window-top-border {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		height: 1px;
		background-color: var(--color-window-border-top);
		z-index: 10002;
		pointer-events: none;
	}

	.custom-title-bar.scrolled {
		border-bottom-color: var(--color-border-muted);
	}

	.tab-area {
		display: flex;
		flex: 1;
		height: 100%;
		overflow: hidden;
		min-width: 0;
		position: relative;
	}

	/*
	 * What the window tag covers, drawn once for the whole strip.
	 *
	 * A window tag is a property of the window: `TabManager.windowTag` is one
	 * nullable record and no tab carries membership of it. Every tab in the
	 * window is under the tag, including the one opened a second from now.
	 * A per-tab underline would say the opposite — that belonging is something
	 * each tab has or lacks — and would then need a per-tab truth to read,
	 * which does not exist and would have to be invented and kept in sync. One
	 * line under the strip cannot disagree with the data, and a new tab lands
	 * on it by construction rather than by remembering to mark it.
	 *
	 * The bottom edge is free: `.tab.active` in Tab.svelte marks the active tab
	 * with `background-color`, so nothing else in the strip is using this
	 * channel and the two readings do not compete.
	 *
	 * Above `.scroll-shadow` (20) and `.new-tab-btn` (21) in TabList, which
	 * would otherwise cover the ends of the line.
	 */
	.tab-area.tagged::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 2px;
		background: var(--tag-color);
		pointer-events: none;
		z-index: 30;
	}

	.window-controls-left {
		display: flex;
		align-items: center;
		padding-left: 10px;
		gap: 12px;
		position: relative;
		z-index: 10000;
	}

	.custom-title-bar.native-mac .window-controls-left {
		padding-left: 78px;
	}

	.title-actions-container {
		display: flex;
		align-items: center;
		position: relative;
		margin-right: 8px;
		margin-left: auto;
		gap: 4px;
		z-index: 10000;
	}

	.kebab-btn {
		display: flex;
		width: 28px;
		height: 28px;
		justify-content: center;
		align-items: center;
		background: transparent;
		border: none;
		color: var(--color-fg-muted);
		border-radius: 4px;
		cursor: pointer;
		transition: all 0.1s;
	}

	.kebab-btn:hover,
	.kebab-btn.active {
		background: var(--color-canvas-subtle);
		color: var(--color-fg-default);
	}

	.title-actions {
		display: flex !important;
		flex-direction: row !important;
		align-items: center !important;
		gap: 4px !important;
	}

	.title-actions.show-dropdown {
		display: flex !important;
		flex-direction: column !important;
		align-items: stretch !important;
		gap: 1px !important;
		position: absolute;
		top: 100%;
		right: 0;
		margin-top: 4px;
		background-color: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		padding: 4px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
		z-index: 10006;
		width: 200px;
	}

	.theme-dropdown-container {
		display: block;
		width: 100%;
	}

	.title-actions.show-dropdown .title-action-btn {
		width: 100%;
		justify-content: flex-start;
		align-items: center;
		padding: 6px 12px;
		height: auto;
		font-size: 13px;
		color: var(--color-fg-default);
		font-family: var(--win-font);
		gap: 8px;
	}

	.title-actions.show-dropdown .title-action-btn svg {
		width: 14px;
		min-width: 14px;
		height: 14px;
		flex-shrink: 0;
		display: block;
		margin: 0;
		color: var(--color-fg-muted);
	}

	.title-actions.show-dropdown .title-action-btn.active {
		color: var(--color-accent-fg);
	}

	.title-actions.show-dropdown .title-action-btn.active svg {
		color: var(--color-accent-fg);
	}

	.title-actions.show-dropdown .action-label {
		display: block;
		margin-left: 0;
		font-size: 13px;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
	}

	.action-label {
		display: none;
	}

	.actions-wrapper {
		display: flex;
		gap: 4px;
	}

	.title-action-btn {
		width: 28px;
		height: 28px;
		display: flex;
		justify-content: center;
		align-items: center;
		background: transparent;
		border: none;
		color: var(--color-fg-muted);
		border-radius: 4px;
		cursor: pointer;
		transition: all 0.1s;
	}

	.title-actions.show-dropdown .menu-zoom-item {
		width: 100%;
		display: flex;
		justify-content: flex-start;
		align-items: center;
		padding: 6px 12px;
		height: auto;
		font-size: 13px;
		color: var(--color-fg-default);
		font-family: var(--win-font);
		gap: 8px;
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.title-actions.show-dropdown .menu-zoom-item:hover {
		background: var(--color-canvas-subtle);
	}

	.title-actions.show-dropdown .menu-zoom-item svg {
		width: 14px;
		min-width: 14px;
		height: 14px;
		flex-shrink: 0;
		display: block;
		margin: 0;
		color: var(--color-fg-muted);
	}

	:global(.title-actions.show-dropdown .menu-zoom-item .zoom-value) {
		width: 32px;
		text-align: left;
		color: var(--color-fg-default);
		display: inline-block;
	}

	.title-action-btn.active {
		color: var(--color-accent-fg);
		background: var(--color-canvas-subtle);
	}

	.title-action-btn:hover {
		background: var(--color-canvas-subtle);
		color: var(--color-fg-default);
	}

	.title-action-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.title-action-btn:disabled:hover {
		background: transparent;
		color: var(--color-fg-muted);
	}

	.window-icon {
		width: 16px;
		height: 16px;
		opacity: 0.8;
	}

	@media (prefers-color-scheme: light) {
		.window-icon {
			filter: grayscale(1) brightness(0.2);
			opacity: 0.6;
		}
	}

	.icon-home-btn {
		background: transparent;
		border: none;
		padding: 4px;
		margin: -4px;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition: background 0.1s;
	}

	.icon-home-btn:hover,
	.icon-home-btn.active {
		background: var(--color-canvas-subtle);
	}

	.window-title-container {
		position: absolute;
		left: 0;
		right: 0;
		top: 0;
		bottom: 0;
		display: flex;
		justify-content: center;
		align-items: center;
		z-index: 5;
	}

	.window-title {
		font-size: 12px;
		transition: opacity 0.2s;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		display: block;
		max-width: calc(100vw - 450px);
	}

	@media (max-width: 800px) {
		.window-title {
			max-width: calc(100vw - 260px);
		}
	}

	.title-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		display: block;
	}

	.window-title.focused {
		opacity: 0.8;
		color: var(--color-fg-default);
	}

	.window-title.unfocused {
		opacity: 0.4;
		color: var(--color-fg-default);
	}

	.window-controls-right {
		display: flex;
		height: 100%;
		position: relative;
		z-index: 10000;
	}

	.control-btn {
		width: 46px;
		height: 32px;
		display: flex;
		justify-content: center;
		align-items: center;
		background: transparent;
		border: none;
		color: var(--color-fg-default);
		opacity: 0.8;
		cursor: default;
		transition: all 0.1s;
	}

	.control-btn:hover {
		background: var(--color-canvas-subtle);
		opacity: 1;
	}

	.close-btn:hover {
		background: #e81123 !important;
	}

	.zoom-indicator {
		background: var(--color-canvas-subtle);
		color: var(--color-fg-muted);
		border: 1px solid var(--color-border-default);
		border-radius: 4px;
		padding: 2px 8px;
		font-size: 11px;
		cursor: pointer;
		margin-right: 8px;
		display: flex;
		align-items: center;
		height: 24px;
		align-self: center;
		transition: all 0.1s;
	}

	.zoom-indicator:hover {
		background: var(--color-btn-hover-bg);
		color: var(--color-fg-default);
		border-color: var(--color-border-muted);
	}


	.macos-traffic-lights {
		display: flex;
		gap: 8px;
		margin-right: 12px;
		align-items: center;
		padding-left: 2px;
	}

	.mac-btn {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		border: 1px solid rgba(0, 0, 0, 0.1);
		display: flex;
		justify-content: center;
		align-items: center;
		padding: 0;
		cursor: default;
		outline: none;
		position: relative;
		overflow: hidden;
	}

	.mac-close {
		background-color: #ff5f57;
		border-color: #e0443e;
	}

	.mac-minimize {
		background-color: #febc2e;
		border-color: #d3a125;
	}

	.mac-maximize {
		background-color: #28c840;
		border-color: #1ca431;
	}

	.mac-icon {
		opacity: 0;
		color: #4d0000;
		transition: opacity 0.1s;
	}

	.mac-minimize .mac-icon {
		color: #995700;
	}

	.mac-maximize .mac-icon {
		color: #006500;
	}

	.macos-traffic-lights:hover .mac-icon {
		opacity: 0.6;
	}

	.mac-btn:active {
		filter: brightness(0.9);
	}

	.custom-tooltip {
		position: fixed;
		background: var(--color-canvas-overlay);
		color: var(--color-fg-default);
		padding: 4px 8px;
		border-radius: 6px;
		font-size: 11px;
		font-family: var(--win-font), 'Segoe UI', sans-serif;
		pointer-events: none;
		z-index: 10005;
		transform: translateX(-50%) translateY(-4px);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		border: 1px solid var(--color-border-default);
		display: flex;
		flex-direction: column;
		align-items: center;
		white-space: nowrap;
		gap: 2px;
		opacity: 0;
		transition:
			opacity 0.15s ease,
			transform 0.15s ease,
			width 0.2s cubic-bezier(0.2, 0, 0.2, 1),
			height 0.2s cubic-bezier(0.2, 0, 0.2, 1);
	}

	.custom-tooltip.align-center {
		transform: translateX(-50%) translateY(-4px);
	}
	.custom-tooltip.align-left {
		transform: translateX(0) translateY(-4px);
		align-items: flex-start;
	}
	.custom-tooltip.align-right {
		transform: translateX(-100%) translateY(-4px);
		align-items: flex-end;
	}

	.custom-tooltip.visible {
		opacity: 1;
	}
	.custom-tooltip.visible.align-center {
		transform: translateX(-50%) translateY(0);
	}
	.custom-tooltip.visible.align-left {
		transform: translateX(0) translateY(0);
	}
	.custom-tooltip.visible.align-right {
		transform: translateX(-100%) translateY(0);
	}

	.tooltip-shortcut {
		color: var(--color-fg-muted);
		font-size: 10px;
		font-family: inherit;
	}

	.theme-dropdown-container {
		position: relative;
	}

	.theme-menu {
		position: absolute;
		top: 100%;
		right: 0;
		margin-top: 4px;
		background-color: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
		padding: 4px;
		display: flex;
		flex-direction: column;
		width: 120px;
		z-index: 10005;
		gap: 1px;
	}

	.theme-menu-divider {
		height: 1px;
		background-color: var(--color-border-default);
		margin: 4px 0;
		transform: scaleY(0.5);
	}

	.theme-option {
		background: transparent;
		border: none;
		text-align: left;
		padding: 6px 12px;
		font-size: 12px;
		color: var(--color-fg-default);
		cursor: pointer;
		border-radius: 4px;
		font-family: var(--win-font);
	}

	.theme-option:hover {
		background-color: var(--color-canvas-subtle);
	}

	.theme-option.selected {
		color: var(--color-accent-fg);
		font-weight: 600;
	}

	.menu-shortcut {
		display: none;
		margin-left: auto;
		font-size: 11px;
		color: var(--color-fg-muted);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.home-menu-item .menu-shortcut,
	.title-actions.show-dropdown .menu-shortcut {
		display: block;
	}

	.home-menu-container {
		position: relative;
		display: flex;
		align-items: center;
		height: 100%;
	}

	.home-dropdown-menu {
		position: absolute;
		top: 100%;
		left: 0;
		margin-top: 4px;
		background-color: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
		padding: 4px;
		display: flex;
		flex-direction: column;
		width: 200px;
		z-index: 10006;
		gap: 1px;
	}

	.window-tag-container { position: relative; display: flex; align-items: center; margin-left: 4px; }
	.window-tag-chip { border: 0; border-radius: 10px; background: var(--tag-color); color: #fff; padding: 3px 10px; font: 600 11px var(--win-font); cursor: pointer; }
	.tag-editor { position: absolute; top: 28px; left: 0; z-index: 20000; width: 180px; padding: 10px; display: flex; flex-direction: column; gap: 8px; background: var(--color-canvas-default); border: 1px solid var(--color-border-default); border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, .2); font-family: var(--win-font); }
	.tag-editor input { box-sizing: border-box; width: 100%; padding: 6px 8px; color: var(--color-fg-default); background: var(--color-canvas-default); border: 1px solid var(--color-border-default); border-radius: 6px; font-family: var(--win-font); font-size: 12px; outline: none; }
	.tag-editor input:focus { border-color: var(--color-accent-fg); }
	.tag-error { margin: 0; color: var(--color-danger-fg); font-size: 11px; line-height: 1.4; }
	.tag-colors { display: flex; justify-content: space-between; padding: 2px 0; }
	.tag-colors button { width: 18px; height: 18px; padding: 0; border: 2px solid transparent; border-radius: 50%; background: var(--tag-color); cursor: pointer; transition: transform 0.1s ease, border-color 0.1s ease; }
	.tag-colors button:hover { transform: scale(1.15); }
	.tag-colors button.selected { border-color: var(--color-fg-default); transform: scale(1.15); }
	.tag-save-btn { width: 100%; padding: 6px 12px; background: var(--color-accent-emphasis); color: #ffffff; border: none; border-radius: 6px; font-family: var(--win-font); font-size: 12px; font-weight: 600; cursor: pointer; transition: background-color 0.15s ease; }
	.tag-save-btn:hover { background: color-mix(in srgb, var(--color-accent-emphasis) 85%, #000); }
	.tag-action-btn { width: 100%; padding: 5px 10px; background: transparent; color: var(--color-fg-muted); border: 1px solid var(--color-border-default); border-radius: 6px; font-family: var(--win-font); font-size: 11px; cursor: pointer; transition: background-color 0.15s ease, color 0.15s ease; }
	.tag-action-btn:hover { background: var(--color-canvas-subtle); color: var(--color-fg-default); }
	.tag-action-btn.danger:hover { background: color-mix(in srgb, var(--color-danger-fg) 15%, transparent); color: var(--color-danger-fg); border-color: var(--color-danger-fg); }

	.home-menu-item {
		display: flex;
		align-items: center;
		background: transparent;
		border: none;
		text-align: left;
		padding: 6px 12px;
		font-size: 13px;
		color: var(--color-fg-default);
		cursor: pointer;
		border-radius: 4px;
		font-family: var(--win-font);
		gap: 8px;
		white-space: nowrap;
	}

	.home-menu-item:hover {
		background-color: var(--color-canvas-subtle);
	}

	.home-menu-item svg {
		color: var(--color-fg-muted);
	}

	.home-menu-divider {
		height: 1px;
		background-color: var(--color-border-default);
		margin: 4px 0;
	}

	.home-menu-footer {
		display: block;
		width: 100%;
		text-align: center;
		padding: 6px 12px;
		font-size: 11px;
		color: var(--color-fg-subtle);
		background-color: transparent;
		text-decoration: none;
		border-radius: 4px;
		font-family: var(--win-font);
		margin-top: 2px;
		border: none;
		cursor: pointer;
	}

	.home-menu-footer:hover {
		color: var(--color-fg-default);
	}
</style>
