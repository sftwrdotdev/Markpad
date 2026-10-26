export interface CloseTabDeps {
	canCloseTab(tabId: string): Promise<boolean>;
	tabCount(): number;
	savePinnedTagIfNeeded(): Promise<void>;
	closeTab(tabId: string): void;
	unwatchFile(): void;
	closeWindowWithLastTab(): boolean;
	destroyWindow(): Promise<void>;
}

/** Closes a tab, and the window with it when it was the last and the setting says so (#829). */
export async function closeTabAndWindowIfLast(tabId: string, deps: CloseTabDeps): Promise<void> {
	if (!(await deps.canCloseTab(tabId))) return;

	if (deps.tabCount() === 1) await deps.savePinnedTagIfNeeded();
	deps.closeTab(tabId);
	if (deps.tabCount() > 0) return;

	deps.unwatchFile();
	// Off, the empty window stays and renders Home.
	if (deps.closeWindowWithLastTab()) await deps.destroyWindow();
}
