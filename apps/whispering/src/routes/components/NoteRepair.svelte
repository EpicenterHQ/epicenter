<!--
	A note that does not read: why, its text as it is, and a repair. Saving
	replaces the whole note with the text, which must read and fit (else it
	says why and keeps the draft); it is written in house style, wherever the
	note is: in this browser, or in the repository.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { notePath } from '$lib/deletion.js';
	import { getWhispering, type Repair } from '$lib/whispering.svelte.js';
	import { confirmDelete } from './file-actions.js';

	let { repair }: { repair: Repair } = $props();
	const whispering = getWhispering();

	// svelte-ignore state_referenced_locally
	let draft = $state(repair.text ?? '');
	let problem = $state<string>();
	let saving = $state(false);

	async function save() {
		saving = true;
		problem = await whispering.replace({ collection: repair.collection, id: repair.id }, draft);
		saving = false;
	}
</script>

<section class="flex flex-col gap-2 text-sm" data-testid="note-repair" data-path={notePath(repair)}>
	<p class="flex flex-wrap items-center gap-2 font-medium">
		<Badge variant="destructive">Needs repair</Badge>
		<code class="font-mono text-xs">{notePath(repair)}</code>
	</p>
	<p class="text-xs text-muted-foreground" data-testid="repair-reason">{repair.reason}</p>
	{#if repair.text === null}
		<p class="text-xs text-muted-foreground" role="status">It is not UTF-8 text, so it is not opened here. Delete it, or fix it where it is.</p>
	{:else}
		<Textarea
			class="min-h-40 resize-y font-mono text-xs"
			bind:value={draft}
			aria-label="Text of {notePath(repair)}"
			spellcheck={false}
			data-testid="repair-text"
		/>
		{#if problem}
			<p class="text-xs text-destructive" role="alert" data-testid="repair-problem">Not saved: {problem}</p>
		{/if}
	{/if}
	<div class="flex items-center gap-1">
		{#if repair.text !== null}
			<Button size="sm" disabled={saving} onclick={() => void save()} data-testid="repair-save">Save</Button>
		{/if}
		<Button
			size="sm"
			variant="ghost-destructive"
			onclick={() => confirmDelete(whispering, { collection: repair.collection, id: repair.id })}
			data-testid="repair-delete"
		>
			Delete
		</Button>
	</div>
</section>
