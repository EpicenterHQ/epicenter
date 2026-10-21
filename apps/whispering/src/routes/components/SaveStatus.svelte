<!--
	Whether what is typed into one file is saved: Saving…, the saved line, or
	Not saved with Try again and Discard. Discard leaves the file as it is and
	offers the typing it let go to copy, so nothing typed is lost unseen.
-->
<script lang="ts">
	import { getWhispering } from '$lib/whispering.svelte.js';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
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

	function discard() {
		const typing = whispering.discard(path);
		if (!typing) return;
		toast.info('Your unsaved typing was let go', {
			description: 'The file keeps what it held.',
			action: { label: 'Copy it', onClick: () => void copyText(typing, 'your typing') },
		});
	}
</script>

<p class={['text-xs text-muted-foreground', className]} role="status" data-testid="write-status">
	{saving ? 'Saving…' : unsaved ? 'Not saved' : saved}
	{#if unsaved && !saving}
		<Button variant="link" size="xs" class="h-auto p-0" onclick={() => void fileEdit.save()}>Try again</Button>
		<Button variant="link" size="xs" class="h-auto p-0" onclick={discard}>Discard</Button>
	{/if}
</p>
