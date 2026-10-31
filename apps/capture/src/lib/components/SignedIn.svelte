<!--
	The signed-in boundary: the person's `capture` repository for everything
	under it (`getRepo`, read by the "Synced" page), and the uploader that
	moves every capture in this browser into it (decisions 12 and 76).
-->
<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { capture } from '@epicenter/capture';
	import { openRemote, startUploading } from '@epicenter/folder/remote';
	import { setRepo } from '@epicenter/svelte/repo';
	import { onDestroy, type Snippet } from 'svelte';
	import { device } from '$lib/device.js';

	// One account for this component's life: the parent's `{#key}` makes a
	// new one for a new account, and sign-out or replacement retires this
	// repository and its uploader.
	const { account, children }: { account: Account; children: Snippet } = $props();

	// svelte-ignore state_referenced_locally
	const repo = setRepo(openRemote(capture, { account }));
	// Each view follows its own client: an uploaded capture leaves this
	// browser's and appears in the repository's.
	const uploader = startUploading(device, repo);
	onDestroy(() => uploader[Symbol.dispose]());
</script>

{@render children()}
