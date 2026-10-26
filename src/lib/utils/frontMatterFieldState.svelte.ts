import type { FrontMatterField } from './frontMatter.js';

/**
 * The front-matter panel's per-field state. Every table is keyed by document
 * *and* field: a bare field name carried a `date` error from one document into
 * every other document's `date` field.
 */
export class FrontMatterFieldState {
	#panelKey: () => string;
	#editErrors = $state<Record<string, string>>({});
	#tagDrafts = $state<Record<string, string>>({});
	#tagEditIndexes = $state<Record<string, number | null>>({});
	#tagEditDrafts = $state<Record<string, string>>({});

	constructor(panelKey: () => string) {
		this.#panelKey = panelKey;
	}

	#key(field: FrontMatterField) {
		return `${this.#panelKey()}:${field.key}`;
	}

	editError(field: FrontMatterField): string | undefined {
		return this.#editErrors[this.#key(field)];
	}

	setEditError(field: FrontMatterField, error: unknown) {
		this.#editErrors[this.#key(field)] = String(error);
	}

	clearEditError(field: FrontMatterField) {
		delete this.#editErrors[this.#key(field)];
	}

	tagDraft(field: FrontMatterField) {
		return this.#tagDrafts[this.#key(field)] ?? '';
	}

	setTagDraft(field: FrontMatterField, value: string) {
		this.#tagDrafts[this.#key(field)] = value;
		this.clearEditError(field);
	}

	clearTagDraft(field: FrontMatterField) {
		delete this.#tagDrafts[this.#key(field)];
	}

	tagEditIndex(field: FrontMatterField) {
		return this.#tagEditIndexes[this.#key(field)] ?? null;
	}

	tagEditDraft(field: FrontMatterField, fallback: string) {
		return this.#tagEditDrafts[this.#key(field)] ?? fallback;
	}

	setTagEditDraft(field: FrontMatterField, value: string) {
		this.#tagEditDrafts[this.#key(field)] = value;
		this.clearEditError(field);
	}

	startTagEdit(field: FrontMatterField, index: number, value: string) {
		const key = this.#key(field);
		this.#tagEditIndexes[key] = index;
		this.#tagEditDrafts[key] = value;
		this.clearEditError(field);
	}

	clearTagEdit(field: FrontMatterField) {
		const key = this.#key(field);
		delete this.#tagEditIndexes[key];
		delete this.#tagEditDrafts[key];
	}
}
