/**
 * Reactive getters over one Folder-owned working document. Construction and
 * untracked reads are passive. Each adapter shares one document subscription
 * among its tracking effects; at zero effects it releases only that subscription.
 * The Folder retains input, autosave, publications and failures independently.
 */
import type { AnyFieldsSchema, FileDocument } from '@epicenter/folder/document';
import { createSubscriber } from 'svelte/reactivity';
import type { TSchema } from 'typebox';

const adapters = new WeakMap<object, unknown>();

/**
 * Track a shared document through Svelte getters. Reuse its passive adapter so
 * repeated adaptation inside a derived read does not rebuild subscriptions.
 */
export function reactiveDocument<TDocumentSchema extends TSchema>(
	document: FileDocument<TDocumentSchema>,
) {
	const cached = adapters.get(document) as
		| ReturnType<typeof adapt<TDocumentSchema>>
		| undefined;
	if (cached !== undefined) return cached;
	const adapter = adapt(document);
	adapters.set(document, adapter);
	return adapter;
}

export type ReactiveDocument<
	TDocumentSchema extends TSchema = AnyFieldsSchema,
> = ReturnType<typeof reactiveDocument<TDocumentSchema>>;

function adapt<TDocumentSchema extends TSchema>(
	document: FileDocument<TDocumentSchema>,
) {
	const track = createSubscriber((update) => {
		// subscribe answers synchronously; the getter reads that snapshot itself.
		let ran = false;
		const stop = document.subscribe(() => {
			if (ran) update();
		});
		ran = true;
		return stop;
	});
	const snapshot = () => {
		track();
		return document.getSnapshot();
	};
	return {
		path: document.path,
		/** Current working content, or undefined before acquisition supplies text. */
		get content() {
			return snapshot().content;
		},
		/** Why the latest applicable read supplied no text. */
		get loadError() {
			return snapshot().loadError;
		},
		/** Accepted input no publication or delete has acknowledged. */
		get isDirty() {
			return snapshot().isDirty;
		},
		/** Publications admitted and not settled. */
		get isSaving() {
			return snapshot().isSaving;
		},
		/** Last applicable failed publication, until success or discard. */
		get saveError() {
			return snapshot().saveError;
		},
		replace: document.replace,
		patch: document.patch,
		save: document.save,
		refresh: document.refresh,
		discard: document.discard,
	};
}
