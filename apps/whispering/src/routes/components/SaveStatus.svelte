<!-- Publication status and recovery actions for the folder-owned source. -->
<script lang="ts">
	import { getFolder } from '$lib/folder.js';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { copyText } from './file-actions.js';

	let { path, class: className = '' }: { path: string; class?: string } = $props();
	const { folder, getStatus } = getFolder();
	const status = $derived(getStatus());
	const failure = $derived(status.failures.find((failure) => failure.path === path));

	function discard() {
		const typing = folder.files.document(path).discard();
		if (typing === undefined) return;
		toast.info('Your unsaved typing was let go', {
			action: { label: 'Copy it', onClick: () => void copyText(typing, 'your typing') },
		});
	}
</script>

<div class={['text-xs text-muted-foreground', className]} role="status" data-testid="write-status">
	<p>
		{status.savingPaths.includes(path) ? 'Saving…' : status.unsaved.includes(path) ? 'Not saved' : 'No unsaved changes'}
		{#if status.unsaved.includes(path) || failure}
			<Button variant="link" size="xs" class="h-auto p-0" onclick={() => void folder.files.document(path).save()}>Try again</Button>
			<Button variant="link" size="xs" class="h-auto p-0" onclick={discard}>Discard</Button>
		{/if}
	</p>
	{#if failure?.error}
		<p role="alert">{failure.error.message}</p>
	{/if}
</div>
