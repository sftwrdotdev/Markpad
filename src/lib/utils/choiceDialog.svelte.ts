export type DialogChoice = 'save' | 'discard' | 'cancel';

/** The one save/discard/cancel dialog the viewer shows. */
export class ChoiceDialog {
	show = $state(false);
	title = $state('');
	message = $state('');
	kind = $state<'info' | 'warning' | 'error'>('info');
	showSave = $state(false);
	resolve: ((v: DialogChoice) => void) | null = null;

	ask(message: string, options: { title: string; kind: 'info' | 'warning' | 'error'; showSave?: boolean }): Promise<DialogChoice> {
		// A second question replaces the first dialog, so the first caller is
		// answered 'cancel' rather than left awaiting a resolver that is about to
		// be overwritten — a close walk left that way never finished, and the
		// window could not be closed again. An already-answered one ignores it.
		this.resolve?.('cancel');
		return new Promise((resolve) => {
			this.show = true;
			this.title = options.title;
			this.message = message;
			this.kind = options.kind;
			this.showSave = options.showSave ?? false;
			this.resolve = resolve;
		});
	}

	close(choice: DialogChoice) {
		this.resolve?.(choice);
		this.show = false;
	}
}
