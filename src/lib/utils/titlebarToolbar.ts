export type TitlebarToolbarPlacement = 'bar' | 'menu';

type TitlebarToolbarAction = {
	id: string;
	labelKey: string;
	fallbackName: string;
	sample: string;
	defaultPlacement: TitlebarToolbarPlacement;
	required?: boolean;
};

type TitlebarToolbarMove = {
	fromIndex: number;
	toIndex: number;
};

type ConfiguredTitlebarToolbarIds = {
	visibleIds: string[];
	barIds: string[];
	menuIds: string[];
};

const TITLEBAR_TOOLBAR_ACTIONS: TitlebarToolbarAction[] = [
	{ id: 'back', labelKey: 'menu.back', fallbackName: 'Back', sample: '<', defaultPlacement: 'bar' },
	{ id: 'forward', labelKey: 'menu.forward', fallbackName: 'Forward', sample: '>', defaultPlacement: 'bar' },
	{ id: 'reload', labelKey: 'tooltip.reloadFromDisk', fallbackName: 'Reload from Disk', sample: 'R', defaultPlacement: 'bar' },
	{ id: 'toc', labelKey: 'tooltip.showTableOfContents', fallbackName: 'Table of Contents', sample: 'T', defaultPlacement: 'menu' },
	{ id: 'fullWidth', labelKey: 'menu.fullWidth', fallbackName: 'Full Width', sample: 'W', defaultPlacement: 'bar' },
	{ id: 'live', labelKey: 'menu.autoReload', fallbackName: 'Auto-Reload', sample: 'L', defaultPlacement: 'bar' },
	{ id: 'sync', labelKey: 'menu.syncScroll', fallbackName: 'Sync Scroll', sample: 'S', defaultPlacement: 'bar' },
	{ id: 'swap', labelKey: 'menu.swapPanes', fallbackName: 'Swap Panes', sample: '<>', defaultPlacement: 'bar' },
	{ id: 'split', labelKey: 'menu.splitView', fallbackName: 'Split View', sample: '\\', defaultPlacement: 'bar' },
	{ id: 'edit', labelKey: 'tooltip.editFile', fallbackName: 'Edit file', sample: 'E', defaultPlacement: 'bar' },
	{ id: 'editorToolbar', labelKey: 'tooltip.editorToolbar', fallbackName: 'Editor Toolbar', sample: 'TB', defaultPlacement: 'bar' },
	{ id: 'find', labelKey: 'menu.find', fallbackName: 'Find', sample: 'F', defaultPlacement: 'menu' },
	{ id: 'zen', labelKey: 'menu.zenMode', fallbackName: 'Zen Mode', sample: 'Z', defaultPlacement: 'menu' },
	{ id: 'tabs', labelKey: 'menu.openTabs', fallbackName: 'Open Tabs', sample: 'Tab', defaultPlacement: 'menu' },
	{ id: 'zoom', labelKey: 'tooltip.resetZoom', fallbackName: 'Reset Zoom', sample: '%', defaultPlacement: 'menu' },
	{ id: 'theme', labelKey: 'menu.changeTheme', fallbackName: 'Change Theme', sample: 'A', defaultPlacement: 'menu' },
	{ id: 'settings', labelKey: 'tooltip.settings', fallbackName: 'Settings', sample: '...', defaultPlacement: 'menu', required: true },
];

export const DEFAULT_TITLEBAR_TOOLBAR_ORDER = TITLEBAR_TOOLBAR_ACTIONS.map((action) => action.id);

export const DEFAULT_TITLEBAR_TOOLBAR_PLACEMENT = TITLEBAR_TOOLBAR_ACTIONS.reduce<Record<string, TitlebarToolbarPlacement>>(
	(result, action) => {
		result[action.id] = action.defaultPlacement;
		return result;
	},
	{},
);

const knownToolbarIds = new Set(DEFAULT_TITLEBAR_TOOLBAR_ORDER);
const requiredToolbarIds = new Set(TITLEBAR_TOOLBAR_ACTIONS.filter((action) => action.required).map((action) => action.id));

export function normalizeTitlebarToolbarOrder(order: readonly string[] | null | undefined): string[] {
	const normalized: string[] = [];

	for (const id of order ?? []) {
		if (!knownToolbarIds.has(id) || normalized.includes(id)) continue;
		normalized.push(id);
	}

	for (const id of DEFAULT_TITLEBAR_TOOLBAR_ORDER) {
		if (!normalized.includes(id)) normalized.push(id);
	}

	return normalized;
}

export function normalizeTitlebarToolbarHidden(hidden: readonly string[] | null | undefined): string[] {
	const normalized: string[] = [];

	for (const id of hidden ?? []) {
		if (!knownToolbarIds.has(id) || requiredToolbarIds.has(id) || normalized.includes(id)) continue;
		normalized.push(id);
	}

	return normalized;
}

export function normalizeTitlebarToolbarPlacement(
	placement: Record<string, unknown> | null | undefined,
): Record<string, TitlebarToolbarPlacement> {
	const normalized = { ...DEFAULT_TITLEBAR_TOOLBAR_PLACEMENT };

	for (const [id, value] of Object.entries(placement ?? {})) {
		if (!knownToolbarIds.has(id)) continue;
		if (value !== 'bar' && value !== 'menu') continue;
		normalized[id] = value;
	}

	return normalized;
}

export function getTitlebarToolbarActions(order: readonly string[] | null | undefined): TitlebarToolbarAction[] {
	const byId = new Map(TITLEBAR_TOOLBAR_ACTIONS.map((action) => [action.id, action]));
	return normalizeTitlebarToolbarOrder(order).map((id) => byId.get(id)!).filter(Boolean);
}

export function getTitlebarToolbarReorderMove(
	order: readonly string[],
	draggedId: string,
	targetId: string,
): TitlebarToolbarMove | null {
	const normalized = normalizeTitlebarToolbarOrder(order);
	const fromIndex = normalized.indexOf(draggedId);
	const toIndex = normalized.indexOf(targetId);

	if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return null;
	return { fromIndex, toIndex };
}

export function getTitlebarToolbarAdjacentMove(
	order: readonly string[],
	id: string,
	direction: 'up' | 'down',
): TitlebarToolbarMove | null {
	const normalized = normalizeTitlebarToolbarOrder(order);
	const fromIndex = normalized.indexOf(id);
	if (fromIndex === -1) return null;

	const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1;
	if (toIndex < 0 || toIndex >= normalized.length) return null;

	return { fromIndex, toIndex };
}

export function applyTitlebarToolbarMove(order: readonly string[], move: TitlebarToolbarMove): string[] {
	const normalized = normalizeTitlebarToolbarOrder(order);
	if (
		move.fromIndex < 0 ||
		move.fromIndex >= normalized.length ||
		move.toIndex < 0 ||
		move.toIndex >= normalized.length ||
		move.fromIndex === move.toIndex
	) {
		return normalized;
	}

	const next = [...normalized];
	const [moved] = next.splice(move.fromIndex, 1);
	next.splice(move.toIndex, 0, moved);
	return next;
}

export function getConfiguredTitlebarToolbarIds(
	availableIds: readonly string[],
	order: readonly string[] | null | undefined,
	hidden: readonly string[] | null | undefined,
	placement: Record<string, unknown> | null | undefined,
): ConfiguredTitlebarToolbarIds {
	const available = new Set(availableIds.filter((id) => knownToolbarIds.has(id)));
	const hiddenIds = new Set(normalizeTitlebarToolbarHidden(hidden));
	const normalizedPlacement = normalizeTitlebarToolbarPlacement(placement);
	const visibleIds = normalizeTitlebarToolbarOrder(order).filter((id) => available.has(id) && !hiddenIds.has(id));

	return {
		visibleIds,
		barIds: visibleIds.filter((id) => normalizedPlacement[id] === 'bar'),
		menuIds: visibleIds.filter((id) => normalizedPlacement[id] === 'menu'),
	};
}
