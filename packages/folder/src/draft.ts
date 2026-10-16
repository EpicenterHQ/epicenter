/**
 * An edit of a file's text that holds its own starting version (ADR-0548,
 * ADR-0551).
 *
 * A file's text is a whole text, and setting it would replace another
 * writer's lines. Its edit is a text draft: the text typed and the version
 * it started from, saved over that version with `files.save`, so the save
 * merges by line with whatever changed since. A row's body is opened with
 * `createBodyEditor` instead (`@epicenter/folder/svelte`).
 *
 * A draft captures the version at the first change, not when an editor
 * gains focus, and keeps the text outside the cache. A refetch updates the
 * cache, never the draft. After a save, the version written is the new base;
 * when the save merged another writer's lines, text typed while it ran is
 * merged onto the written text, so the next save does not undo them.
 *
 * The base is a file's capture; `writtenFile` reads what a save wrote.
 *
 * Plain TypeScript with no framework: a Svelte wrapper keeps a draft in
 * `$state` and calls these.
 */
import type { CapturedFile, ContentCapture } from './capture.js';
import { mergeLines } from './git/merge-lines.js';
import type { FileContent } from './merge-file.js';
import type { SavedFile } from './save-file.js';

/**
 * What a file save sends: the version the edit started from, and the
 * content, as `files.write` takes them. A text draft sends its text; the
 * restore of what a save replaced may send bytes.
 */
export type SaveTextVariables = {
	readonly base: ContentCapture;
	readonly content: FileContent;
};

/** What a text draft sends: the version it started from, and its text. */
export type SentText<TBase extends ContentCapture = ContentCapture> = {
	readonly base: TBase;
	readonly content: string;
	readonly revision: number;
};

/** What a save of a text draft wrote: the version, its text, and whether it merged. */
export type WrittenText<TBase extends ContentCapture = ContentCapture> = {
	readonly base: TBase;
	readonly text: string;
	readonly merged: boolean;
};

/** An edit of one document's exact text. */
export type TextDraft<TBase extends ContentCapture = ContentCapture> = {
	/** The version the edit started from; `undefined` before the first change. */
	readonly base: TBase | undefined;
	/** The text typed; `undefined` before the first change. */
	readonly text: string | undefined;
	/**
	 * Type `text`. The first change captures `current`, the document as the
	 * cache holds it now, as the base; later ones ignore it.
	 */
	change(current: TBase, text: string): void;
	/** What the save sends; `undefined` with no edit. */
	toSave(): SentText<TBase> | undefined;
	/**
	 * A save of `sent` landed as `written`. With no change since, the draft
	 * is done. Otherwise the written version is the new base, and when the
	 * save merged, the text typed since is merged onto the written text,
	 * where the typed lines win.
	 */
	saved(sent: SentText<TBase>, written: WrittenText<TBase>): Promise<void>;
	/** Drop the edit. */
	discard(): void;
};

const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

/** What a file save wrote, as a text draft reads it. */
export function writtenFile(saved: SavedFile): WrittenText<CapturedFile> {
	return {
		base: saved.stored,
		text: utf8.decode(saved.stored.bytes),
		merged: saved.merged,
	};
}

export function createTextDraft<
	TBase extends ContentCapture = ContentCapture,
>(): TextDraft<TBase> {
	let base: TBase | undefined;
	let text: string | undefined;
	/** Counts changes, so a save knows whether the draft moved on while it ran. */
	let revision = 0;
	return {
		get base() {
			return base;
		},
		get text() {
			return text;
		},
		change(current, next) {
			base ??= current;
			text = next;
			revision++;
		},
		toSave() {
			if (base === undefined || text === undefined) return undefined;
			return { base, content: text, revision };
		},
		async saved(sent, written) {
			if (sent.revision === revision) {
				base = undefined;
				text = undefined;
				return;
			}
			if (!written.merged) {
				// The file holds the text sent, so the later typing is exactly
				// what the draft holds beyond the version written.
				base = written.base;
				return;
			}
			const from = base;
			for (;;) {
				const at = revision;
				const typed = text;
				// Discarded, or discarded and begun again, while the merge ran.
				if (typed === undefined || base !== from) return;
				// Lines typed since the save win where the merge changed them too.
				const merged = await mergeLines({
					base: sent.content,
					ours: typed,
					theirs: written.text,
				});
				// Typing during the merge edited the text it read; merge again.
				if (at !== revision) continue;
				text = merged.ours;
				base = written.base;
				return;
			}
		},
		discard() {
			base = undefined;
			text = undefined;
		},
	};
}
