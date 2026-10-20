<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import { onDestroy } from 'svelte';
	import type { FolderContext } from '@epicenter/svelte/folder';

	let {
		local,
		prefix,
		name,
		onRename,
		onDelete,
	}: {
		local: FolderContext;
		/** The fixed folder part shown before the editable name, such as `todos/`. */
		prefix: string;
		name: string;
		/** Returns a problem to show, or undefined when the rename is done. */
		onRename: (name: string) => Promise<string | undefined>;
		onDelete: () => void;
	} = $props();

	const id = $props.id();
	// Follows the file's name until the person types a new one.
	let next = $derived(name);
	let renaming = $state(false);
	// The form belongs to this opened folder for its lifetime.
	// svelte-ignore state_referenced_locally
	const unregister = local.registerUnsent(() =>
		next !== name ? 'A file name has not been renamed. Rename or restore it before closing.' : undefined,
	);
	onDestroy(unregister);

	async function rename(event: SubmitEvent) {
		event.preventDefault();
		const value = next;
		if (value === '' || value === name || renaming) return;
		renaming = true;
		const problem = await onRename(value);
		renaming = false;
		if (problem) toast.error('Could not rename the file', { description: problem });
	}
</script>

<form class="flex flex-wrap items-center gap-2 border-t px-4 py-2" onsubmit={rename}>
	<label class="text-xs text-muted-foreground" for={id}>File name</label>
	<div class="flex min-w-0 items-center gap-1">
		{#if prefix}<span class="font-mono text-xs text-muted-foreground">{prefix}</span>{/if}
		<Input {id} class="h-8 w-44 font-mono md:text-xs" bind:value={next} autocomplete="off" spellcheck={false} />
	</div>
	<Button type="submit" size="sm" variant="outline" disabled={renaming || next === '' || next === name}>
		Rename file
	</Button>
	<Button class="ml-auto" size="sm" variant="ghost-destructive" onclick={onDelete}>Delete</Button>
</form>
