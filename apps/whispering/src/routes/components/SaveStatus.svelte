<!--
	Whether what is typed into one file is saved: Saving…, the saved line, or
	Not saved with Try again and Discard. Discard leaves the file as it is and
	offers the typing it let go to copy, so nothing typed is lost unseen.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import type { Library } from '$lib/library.svelte.js';
	import { copyText } from './file-actions.js';

	let {
		library,
		path,
		saved = 'Saved',
		class: className = '',
	}: {
		library: Library;
		path: string;
		/** What the line says once everything typed is saved. */
		saved?: string;
		class?: string;
	} = $props();

	const saving = $derived(library.isSaving(path));
	const unsaved = $derived(library.isUnsaved(path));

	function discard() {
		const typing = library.discard(path);
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
		<Button variant="link" size="xs" class="h-auto p-0" onclick={() => void library.retry(path)}>Try again</Button>
		<Button variant="link" size="xs" class="h-auto p-0" onclick={discard}>Discard</Button>
	{/if}
</p>
