<script lang="ts">
	import type { StoredRow, TableListing } from '@epicenter/folder';
	import type { TableOptions } from '@epicenter/folder/query';
	import { createBodyEditor } from '@epicenter/folder/svelte';
	import { createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { useDebounce } from 'runed';
	import { onDestroy } from 'svelte';
	import { failureText } from './field-input';

	type Fields = Record<string, unknown>;

	/**
	 * One row's body, its notes. A body is a document, so what is typed is
	 * held with the row it started from (ADR-0576): it is saved a second
	 * after the last keystroke, when the box loses focus, and when the panel
	 * goes away, as the change from that row, merged by line with whatever
	 * another window changed since. Where both changed the same lines the
	 * typing wins, with no notice. A row another window deleted takes no
	 * save: what was typed goes to `onlost`, which offers it.
	 * The grid keys this view by the row.
	 */
	let {
		stem,
		stored,
		options,
		onlost,
	}: {
		/** The row this panel edits. */
		stem: string;
		/** The row as the cache holds it now. */
		stored: StoredRow<Fields>;
		options: TableOptions<Fields>;
		/** Keep text typed into a row deleted elsewhere, for the person to copy. */
		onlost: (where: string, text: string) => void;
	} = $props();

	// The grid keys this view by its row: while it replaces one, the prop may
	// already read the next row, so a save sent as it goes away uses this.
	// svelte-ignore state_referenced_locally
	const row = stem;
	const client = useQueryClient();
	/**
	 * The row as the listing holds it now, `undefined` once it is gone or no
	 * longer reads as a row. The panel goes away when that happens, and the
	 * save it sends as it goes must not make the row again.
	 */
	function current(): StoredRow<Fields> | undefined {
		// Read the prop so a new version from the grid wakes the editor.
		void stored;
		const item = client
			.getQueryData<TableListing<Fields>>(options.list.queryKey())
			?.find((entry) => entry.stem === row);
		return item?.result.error === null ? item.result.data : undefined;
	}

	const writeRow = createMutation(() => options.write.mutationOptions());
	const body = createBodyEditor<Fields>({
		row: current,
		write: (change) => writeRow.mutateAsync({ stem: row, ...change }),
	});
	const saveLater = useDebounce(() => body.save(), 1000);
	// svelte-ignore state_referenced_locally
	const lose = onlost;
	/** Hand what is typed to `onlost` once the row is gone. */
	function handOff() {
		const typed = body.typed;
		if (!body.gone || typed === undefined) return;
		body.discard();
		lose(`the notes of ${row}`, typed);
	}
	$effect(handOff);
	// runed's timer outlives the panel; save now instead. What the last save
	// leaves typed, because the row is gone or the save failed, goes to
	// `onlost` with the panel, or nothing would hold it.
	onDestroy(
		() =>
			void saveLater
				.runScheduledNow()
				.then(() => body.save())
				.then(() => {
					const typed = body.typed;
					if (typed === undefined) return;
					body.discard();
					lose(`the notes of ${row}`, typed);
				}),
	);
</script>

<label class="flex flex-col gap-1">
	<span class="text-xs font-medium text-muted-foreground">Notes</span>
	<textarea
		class="min-h-48 w-full rounded-md border border-input bg-transparent p-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
		value={body.text ?? ''}
		oninput={(event) => {
			body.change(event.currentTarget.value);
			void saveLater();
		}}
		onblur={() => void saveLater.runScheduledNow()}
	></textarea>
	{#if body.typed !== undefined && !body.saving && !saveLater.pending && writeRow.error}
		<span class="text-xs text-destructive" role="status">
			{failureText(writeRow.error)}
			<button type="button" class="underline" onclick={() => void body.save()}>Try again</button>
		</span>
	{:else}
		<span class="text-xs text-muted-foreground">Saved when you pause or leave the box.</span>
	{/if}
</label>
