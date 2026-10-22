<!-- Publication status and recovery actions for the folder-owned source. -->
<script lang="ts">
	import { getWhispering } from '$lib/whispering.svelte.js';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { copyText } from './file-actions.js';

	let { path, class: className = '' }: { path: string; class?: string } = $props();
	const whispering = getWhispering();
	const fileEdit = $derived(whispering.edit(path));

	function discard() {
		const typing = whispering.discard(path);
		if (typing === undefined) return;
		toast.info('Your unsaved typing was let go', {
			action: { label: 'Copy it', onClick: () => void copyText(typing, 'your typing') },
		});
	}
</script>

<div class={['text-xs text-muted-foreground', className]} role="status" data-testid="write-status">
	<p>
		{fileEdit.isSaving ? 'Saving…' : fileEdit.isDirty ? 'Not saved' : 'No unsaved changes'}
		{#if fileEdit.isDirty || fileEdit.saveError}
			<Button variant="link" size="xs" class="h-auto p-0" onclick={() => void fileEdit.save()}>Try again</Button>
			<Button variant="link" size="xs" class="h-auto p-0" onclick={discard}>Discard</Button>
		{/if}
	</p>
	{#if fileEdit.saveError}
		<p role="alert">{fileEdit.saveError.message}</p>
	{/if}
</div>
