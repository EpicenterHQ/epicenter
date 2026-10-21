<!--
	Whether what is typed into one file is saved: Saving…, the saved line, or
	Not saved with recovery actions. A whole-file conflict shows both sources
	and asks for an explicit choice. Discard offers the exact source to copy.
-->
<script lang="ts">
	import { getWhispering } from '$lib/whispering.svelte.js';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { unsavedText } from '@epicenter/svelte/write-failure';
	import { copyText } from './file-actions.js';

	let {
		path,
		saved = 'Saved',
		class: className = '',
	}: {
		path: string;
		/** What the line says once everything typed is saved. */
		saved?: string;
		class?: string;
	} = $props();
	const whispering = getWhispering();

	const fileEdit = $derived(whispering.edit(path));
	const saving = $derived(whispering.isSaving(path));
	const unsaved = $derived(whispering.isUnsaved(path));
	const pending = $derived(fileEdit.pending);
	const conflict = $derived(pending?.error?.name === 'Conflict' ? pending.error : undefined);
	const savedSource = $derived.by(() => {
		if (conflict === undefined) return undefined;
		if (conflict.current === null) return '(deleted)';
		if (typeof conflict.current === 'string') return conflict.current;
		try {
			return new TextDecoder('utf-8', { fatal: true }).decode(conflict.current);
		} catch {
			return '(binary file)';
		}
	});

	function discard() {
		const typing = whispering.discard(path);
		if (!typing) return;
		toast.info('Your unsaved typing was let go', {
			description: 'The file keeps what it held.',
			action: { label: 'Copy it', onClick: () => void copyText(typing, 'your typing') },
		});
	}
</script>

<div class={['text-xs text-muted-foreground', className]} role="status" data-testid="write-status">
	<p>
		{saving ? 'Saving…' : unsaved ? 'Not saved' : saved}
		{#if unsaved && !saving}
			{#if conflict !== undefined}
				<Button variant="link" size="xs" class="h-auto p-0" onclick={() => void fileEdit.resolveConflict('current')}>Use saved file</Button>
				<Button variant="link" size="xs" class="h-auto p-0" onclick={() => void fileEdit.resolveConflict('draft')}>Replace saved file</Button>
			{:else}
				<Button variant="link" size="xs" class="h-auto p-0" onclick={() => void fileEdit.save()}>Try again</Button>
			{/if}
			<Button variant="link" size="xs" class="h-auto p-0" onclick={discard}>Discard</Button>
		{/if}
	</p>
	{#if conflict !== undefined && pending !== undefined}
		<details>
			<summary>Compare sources</summary>
			<p>Saved source</p><pre class="max-h-40 overflow-auto whitespace-pre-wrap select-text">{savedSource}</pre>
			<p>Your source</p><pre class="max-h-40 overflow-auto whitespace-pre-wrap select-text">{unsavedText(pending)}</pre>
		</details>
	{/if}
</div>
