/**
 * Text a person is typing, ahead of the value it saves to.
 *
 * A folder shows only what landed, so an input bound to it would lose
 * keystrokes typed while a save is out. A draft shows what was typed until
 * that text's save answers, then follows `source` again: the landed text when
 * the save landed, the disk's when it failed (`<OpenFolder>` offers the typed
 * text to copy). Typing newer than an answer keeps the draft.
 *
 * ```svelte
 * const title = draft(
 * 	() => todo?.fields?.title ?? '',
 * 	(title) => folder.tables.todos.update(id, { fields: { title } }),
 * );
 * <input bind:value={title.text} />
 * ```
 *
 * It knows nothing of folders: any value that lands later can take one.
 */
export function draft(
	source: () => string,
	save: (text: string) => Promise<unknown>,
) {
	let typed = $state<string | null>(null);
	let latest = 0;
	const set = (text: string) => {
		typed = text;
		const mine = ++latest;
		void save(text).finally(() => {
			if (mine === latest) typed = null;
		});
	};
	return {
		get text() {
			return typed ?? source();
		},
		set text(text: string) {
			set(text);
		},
		set,
	};
}
