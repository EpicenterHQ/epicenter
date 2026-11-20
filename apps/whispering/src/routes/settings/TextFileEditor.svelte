<!--
	One text file the person edits: the dictionary or the cleanup prompt.

	The box shows the file, or `fallback` when there is none. What the person
	types stays a draft until Save. Saving the fallback itself, or nothing
	when there is no fallback, deletes the file instead, so it keeps following
	the built-in text. Reset appears only when there is built-in text to go
	back to.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Textarea } from '@epicenter/ui/textarea';
	import { toastOnError } from '@epicenter/ui/toast-on-error';
	import { createQuery } from '@tanstack/svelte-query';
	import type { Snippet } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { runMutation } from 'wellcrafted/query';
	import { queryClient, textFilesMutations, textFilesQueries } from '#lib/queries.ts';

	let {
		path,
		legend,
		fallback = '',
		rows,
		placeholder,
		children,
	}: {
		path: string;
		legend: string;
		fallback?: string;
		rows: number;
		placeholder?: string;
		/** The description under the legend. */
		children: Snippet;
	} = $props();

	const file = createQuery(() => textFilesQueries.read(path));
	let draft = $state<string>();
	const own = $derived(typeof file.data === 'string');

	async function save() {
		if (draft === undefined) return;
		const saved =
			draft.trim() === fallback.trim()
				? await runMutation(queryClient, textFilesMutations.remove, { path })
				: await runMutation(queryClient, textFilesMutations.write, { path, text: draft });
		if (saved.error) return toastOnError(saved, `Could not save ${path}`);
		draft = undefined;
		toast.success(`${legend} saved`);
	}

	async function reset() {
		const removed = await runMutation(queryClient, textFilesMutations.remove, { path });
		if (removed.error) return toastOnError(removed, `Could not reset ${path}`);
		draft = undefined;
	}
</script>

<Field.Set>
	<Field.Legend>{legend}</Field.Legend>
	<Field.Description>{@render children()}</Field.Description>
	<Field.Group>
		<Textarea
			{rows}
			{placeholder}
			spellcheck="false"
			bind:value={() => draft ?? file.data ?? fallback, (text) => (draft = text)}
		/>
		<div class="flex gap-2">
			<Button variant="outline" disabled={draft === undefined} onclick={save}>Save</Button>
			{#if fallback && (own || draft !== undefined)}
				<Button variant="ghost" onclick={reset}>Reset to built-in</Button>
			{/if}
		</div>
	</Field.Group>
</Field.Set>
