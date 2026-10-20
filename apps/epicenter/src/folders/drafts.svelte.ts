/**
 * One path-keyed draft and save queue above Files and Tables. Text edits keep
 * their exact starting bytes. Field intent overlays fresh source at display
 * and save time, so unrelated changes stay visible. Failed intent remains
 * copyable and is retried only explicitly or by further input.
 */
import type { FileContent, FolderFiles, SaveError } from '@epicenter/folder';
import { documentChange, readDocument } from '@epicenter/folder/documents';
import { SvelteMap } from 'svelte/reactivity';
import { fileText, savedText } from './files';

export const SAVE_AFTER_MS = 1000;
export type DraftBase = {
	readonly content: FileContent;
	readonly crlf: boolean;
};
type Intent =
	| ({ kind: 'text'; text: string } & DraftBase)
	| { kind: 'fields'; fields: Record<string, unknown> };
type Draft = {
	readonly intent: Intent;
	readonly revision: number;
	readonly error: SaveError | Error | undefined;
};
export type Unsaved = {
	readonly path: string;
	/** Text intent, or an explicit set/remove patch for field intent. */
	readonly text: string;
	readonly error: SaveError | Error | undefined;
};

function applyFields(
	path: string,
	content: FileContent,
	fields: Record<string, unknown>,
) {
	const bytes =
		typeof content === 'string' ? new TextEncoder().encode(content) : content;
	return documentChange(readDocument(path, bytes), { fields });
}

function recoveryText(intent: Intent): string {
	if (intent.kind === 'text') return intent.text;
	return JSON.stringify(
		{
			set: Object.fromEntries(
				Object.entries(intent.fields).filter(
					([, value]) => value !== undefined,
				),
			),
			remove: Object.keys(intent.fields).filter(
				(key) => intent.fields[key] === undefined,
			),
		},
		null,
		2,
	);
}

export function createFileDrafts({
	files,
	saved,
	saveAfterMs = SAVE_AFTER_MS,
}: {
	files: Pick<FolderFiles, 'write' | 'read'>;
	/** Reread saved source before releasing the draft. */
	saved: (path: string) => Promise<void>;
	saveAfterMs?: number;
}) {
	const drafts = new SvelteMap<string, Draft>();
	const timers = new SvelteMap<string, ReturnType<typeof setTimeout>>();
	const running = new SvelteMap<string, Promise<void>>();
	const again = new Set<string>();
	let revisions = 0;

	function clearTimer(path: string) {
		clearTimeout(timers.get(path));
		timers.delete(path);
	}
	function schedule(path: string) {
		clearTimer(path);
		timers.set(
			path,
			setTimeout(() => {
				clearTimer(path);
				void flush(path);
			}, saveAfterMs),
		);
	}
	function flush(path: string, retry = false): Promise<void> {
		clearTimer(path);
		const held = drafts.get(path);
		if (!retry && held?.intent.kind === 'fields' && held.error !== undefined)
			return Promise.resolve();
		const run = running.get(path);
		if (run !== undefined) {
			again.add(path);
			return run;
		}
		const started = drain(path).finally(() => running.delete(path));
		running.set(path, started);
		return started;
	}
	async function drain(path: string) {
		do {
			again.delete(path);
			const draft = drafts.get(path);
			if (draft === undefined) return;
			let content: string;
			let error: SaveError | Error | null = null;
			try {
				let from: FileContent;
				if (draft.intent.kind === 'text') {
					from = draft.intent.content;
					content = savedText(draft.intent.text, draft.intent.crlf);
				} else {
					const read = await files.read(path);
					if (read.error !== null) throw read.error;
					if (read.data === undefined)
						throw new Error(
							'The file no longer exists; discard the field edit before recreating it',
						);
					from = new Uint8Array(await read.data.content.arrayBuffer());
					const changed = applyFields(path, from, draft.intent.fields);
					if (changed.error !== null) throw new Error(changed.error.reason);
					content = changed.data.text;
				}
				({ error } = await files.write(path, from, content));
			} catch (cause) {
				error = cause instanceof Error ? cause : new Error(String(cause));
			}
			const settled = drafts.get(path);
			if (settled === undefined) return;
			if (error !== null) {
				drafts.set(path, {
					...settled,
					error: settled.revision === draft.revision ? error : undefined,
				});
				if (settled.revision === draft.revision) again.delete(path);
				continue;
			}
			await saved(path).catch(() => {});
			const after = drafts.get(path);
			if (after === undefined) return;
			if (after.revision === draft.revision) {
				drafts.delete(path);
				continue;
			}
			let intent = after.intent;
			if (intent.kind === 'fields' && draft.intent.kind === 'fields') {
				const sent = draft.intent.fields;
				const fields = Object.fromEntries(
					Object.entries(intent.fields).filter(
						([key, value]) =>
							!Object.hasOwn(sent, key) || !Object.is(sent[key], value),
					),
				);
				if (Object.keys(fields).length === 0) {
					drafts.delete(path);
					continue;
				}
				intent = { kind: 'fields', fields };
			} else if (intent.kind === 'text' && draft.intent.kind === 'text') {
				intent = { ...intent, content: content! };
			}
			// Field-to-text keeps the displayed base: sent source may contain an
			// external body change the person never saw. The next merge keeps it.
			drafts.set(path, { ...after, intent, error: undefined });
		} while (again.has(path));
	}
	const unsavedOf = (path: string, draft: Draft): Unsaved => ({
		path,
		text: recoveryText(draft.intent),
		error: draft.error,
	});
	return {
		file(path: string) {
			return {
				get text() {
					const intent = drafts.get(path)?.intent;
					return intent?.kind === 'text' ? intent.text : undefined;
				},
				get fieldText() {
					const intent = drafts.get(path)?.intent;
					return intent?.kind === 'fields' ? recoveryText(intent) : undefined;
				},
				shown(base: DraftBase | undefined): string | undefined {
					const intent = drafts.get(path)?.intent;
					if (intent?.kind === 'text') return intent.text;
					if (intent === undefined || base === undefined) return undefined;
					const changed = applyFields(path, base.content, intent.fields);
					return changed.error === null
						? changed.data.text.replaceAll('\r\n', '\n')
						: undefined;
				},
				get sourceLocked() {
					const draft = drafts.get(path);
					return draft?.intent.kind === 'fields' && draft.error !== undefined;
				},
				get held() {
					return drafts.has(path);
				},
				get saving() {
					return running.has(path) || timers.has(path);
				},
				get error() {
					return drafts.get(path)?.error;
				},
				change(fields: Record<string, unknown>, base: DraftBase): boolean {
					const draft = drafts.get(path);
					const textIntent =
						draft?.intent.kind === 'text' ? draft.intent : undefined;
					const patch = {
						...(draft?.intent.kind === 'fields' ? draft.intent.fields : {}),
						...fields,
					};
					const changed = applyFields(
						path,
						textIntent === undefined
							? base.content
							: savedText(textIntent.text, textIntent.crlf),
						patch,
					);
					if (changed.error !== null) return false;
					const shown = fileText(new TextEncoder().encode(changed.data.text));
					if (shown.kind !== 'text') return false;
					const intent: Intent =
						textIntent === undefined
							? { kind: 'fields', fields: patch }
							: { ...textIntent, text: shown.text };
					drafts.set(path, {
						intent,
						revision: ++revisions,
						error: undefined,
					});
					schedule(path);
					return true;
				},
				type(text: string, base: DraftBase | undefined): boolean {
					const draft = drafts.get(path);
					if (draft?.intent.kind === 'fields' && draft.error !== undefined)
						return false;
					const from = draft?.intent.kind === 'text' ? draft.intent : base;
					if (from === undefined) return false;
					if (draft?.intent.kind === 'fields') {
						const preview = applyFields(
							path,
							from.content,
							draft.intent.fields,
						);
						if (preview.error !== null) {
							drafts.set(path, {
								...draft,
								error: new Error(preview.error.reason),
							});
							return false;
						}
					}
					drafts.set(path, {
						intent: {
							kind: 'text',
							content: from.content,
							crlf: from.crlf,
							text,
						},
						revision: ++revisions,
						error: draft?.error,
					});
					schedule(path);
					return true;
				},
				save: () => flush(path),
				retry: () => flush(path, true),
				discard(): boolean {
					if (running.has(path) || !drafts.has(path)) return false;
					clearTimer(path);
					drafts.delete(path);
					return true;
				},
			};
		},
		get held(): string[] {
			return [...drafts.keys()].sort();
		},
		get failures(): Unsaved[] {
			return [...drafts]
				.filter(
					([path, draft]) => draft.error !== undefined && !running.has(path),
				)
				.map(([path, draft]) => unsavedOf(path, draft));
		},
		get busy(): boolean {
			return drafts.size > 0 || running.size > 0;
		},
		async settle(): Promise<Unsaved[]> {
			await Promise.allSettled([...drafts.keys()].map((path) => flush(path)));
			await Promise.allSettled([...running.values()]);
			return [...drafts].map(([path, draft]) => unsavedOf(path, draft));
		},
	};
}
export type FileDrafts = ReturnType<typeof createFileDrafts>;
