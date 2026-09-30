<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';

	let {
		prefix,
		name,
		suffix = '',
		onRename,
		onDelete,
	}: {
		/** The fixed folder part shown before the editable name, such as `todos/`. */
		prefix: string;
		name: string;
		/** A fixed extension shown after the editable name, such as `.md`. */
		suffix?: string;
		/** Returns a problem to show, or undefined when the rename is done. */
		onRename: (name: string) => Promise<string | undefined>;
		onDelete: () => void;
	} = $props();

	const id = $props.id();
	// Follows the file's name until the person types a new one.
	let next = $derived(name);
	let renaming = $state(false);

	async function rename(event: SubmitEvent) {
		event.preventDefault();
		const value = next.trim();
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
		{#if suffix}<span class="font-mono text-xs text-muted-foreground">{suffix}</span>{/if}
	</div>
	<Button type="submit" size="sm" variant="outline" disabled={renaming || next.trim() === '' || next.trim() === name}>
		Rename file
	</Button>
	<Button class="ml-auto" size="sm" variant="ghost-destructive" onclick={onDelete}>Delete</Button>
</form>
