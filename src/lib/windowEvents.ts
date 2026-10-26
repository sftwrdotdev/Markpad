import { emitTo } from '@tauri-apps/api/event';

/**
 * The events one window's frontend sends to a window's frontend (its own or
 * another's). Rust-emitted events are `events.*` in bindings.ts; these never
 * reach Rust, so their names and payloads are declared here, once, and both
 * the sender and the viewer's listener table are checked against them.
 */
export type WindowEvents = {
	'menu-tab-new': undefined;
	'menu-tab-undo': undefined;
	'menu-tab-rename': string;
	'menu-tab-close': string;
	'menu-tab-detach': string;
	'menu-tab-close-others': string;
	'menu-tab-close-right': string;
	'menu-tab-move': { tabId: string; targetLabel: string };
	'merge-into': string;
	'window-identify': string;
};

export type WindowEventName = keyof WindowEvents;

/** Sends `event` to the window labelled `label`. */
export function emitToWindow<E extends WindowEventName>(label: string, event: E, payload?: WindowEvents[E]): Promise<void> {
	return emitTo(label, event, payload);
}
