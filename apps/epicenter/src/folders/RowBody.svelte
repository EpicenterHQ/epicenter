<script lang="ts">
	import type { StoredRow } from '@epicenter/folder';
	import type { TableOptions } from '@epicenter/folder/query';
	import { createBodyEditor } from '@epicenter/folder/svelte';
	import ReplacedNotice from '@epicenter/svelte/replaced-notice';
	import type { Replaced } from '@epicenter/folder';
	import { createMutation } from '@tanstack/svelte-query';
	import { useDebounce } from 'runed';
	import { onDestroy } from 'svelte';
	import { failureText } from './field-input';

	type Fields = Record<string, unknown>;

	/**
	 * One row's body, its notes. A body is a document, so what is typed is a
	 * draft that keeps the version it started from (ADR-0554): it is saved a
	 * second after the last keystroke, when the box loses focus, and when the
	 * panel goes away, over that version, merged by line with whatever another
	 * window changed since. Where both changed the same lines the typing wins,
	 * and a notice names what of theirs it replaced, with "Restore theirs".
	 * The grid keys this view by the row.
	 */
	let {
		stored,
		options,
	}: {
		/** The row as the cache holds it now. */
		stored: StoredRow<Fields>;
		options: TableOptions<Fields>;
	} = $props();

	const save = createMutation(() => options.save.mutationOptions());
	/** What the last save replaced of another window's lines, and the save that puts it back. */
	let notice = $state<{ replaced: readonly Replaced[]; restore: () => void }>();
	/** The body, opened with the version it started from (ADR-0573). */
	const body = createBodyEditor<Fields>({
		row: () => stored,
		save: (variables) => save.mutateAsync(variables),
		onSaved: ({ replaced }, restore) => {
			notice = replaced.length > 0 ? { replaced, restore } : undefined;
		},
	});
	const saveLater = useDebounce(() => body.save(), 1000);
	// runed's timer outlives the panel; save now instead.
	onDestroy(() => void saveLater.runScheduledNow());
</script>

{#if notice !== undefined}
	{@const shown = notice}
	<ReplacedNotice
		replaced={shown.replaced}
		subject={stored.path}
		onRestore={() => {
			notice = undefined;
			shown.restore();
		}}
		onDismiss={() => (notice = undefined)}
	/>
{/if}
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
	{#if body.typed !== undefined && !body.saving && !saveLater.pending && save.error}
		<span class="text-xs text-destructive" role="status">
			{failureText(save.error)}
			<button type="button" class="underline" onclick={() => void body.save()}>Try again</button>
		</span>
	{:else}
		<span class="text-xs text-muted-foreground">Saved when you pause or leave the box.</span>
	{/if}
</label>
