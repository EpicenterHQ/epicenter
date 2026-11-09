<!--
	A button that shows a folder's place in the file manager (`reveal`, from
	the folder or the shell), and why not when it cannot.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import type { Result } from 'wellcrafted/result';

	let { reveal }: { reveal: () => Promise<Result<null, { message: string }>> } = $props();
	let problem = $state<string>();
	let showing = $state(false);
	const label = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent)
		? 'Show in Finder'
		: 'Show folder';

	async function show() {
		showing = true;
		problem = undefined;
		const { error } = await reveal();
		if (error !== null) problem = error.message;
		showing = false;
	}
</script>

<Button variant="outline" disabled={showing} onclick={show}>{label}</Button>
{#if problem}<p role="alert" class="text-sm text-destructive">{problem}</p>{/if}
