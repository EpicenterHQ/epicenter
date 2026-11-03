<script lang="ts">
	import { revealRoot, type Root } from '@epicenter/folder/tauri';
	import { Button } from '@epicenter/ui/button';

	let { root }: { root: Root } = $props();
	let problem = $state<string>();
	let showing = $state(false);
	const label = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent)
		? 'Show in Finder'
		: 'Show folder';

	async function show() {
		showing = true;
		problem = undefined;
		const { error } = await revealRoot(root);
		if (error !== null) problem = error.message;
		showing = false;
	}
</script>

<Button variant="outline" disabled={showing} onclick={show}>{label}</Button>
{#if problem}<p role="alert" class="text-sm text-destructive">{problem}</p>{/if}
