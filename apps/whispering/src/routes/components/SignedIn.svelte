<!--
	The signed-in boundary: the person's `whispering` repository for
	everything under it (`getRepo`, read by the "Synced" pages), and the
	uploader that moves every file on this device into it (decisions 12 and
	76). Recordings made signed out upload to whoever signs in next on this
	browser (decision 67).
-->
<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { openRemote, startUploading } from '@epicenter/folder/remote';
	import { setRepo } from '@epicenter/svelte/repo';
	import { onDestroy, type Snippet } from 'svelte';
	import { whispering } from '$lib/contract.js';
	import { device } from '$lib/device.js';

	// One account for this component's life: the parent's `{#key}` makes a new
	// one for a new account, and sign-out or replacement retires this
	// repository and its uploader.
	const { account, children }: { account: Account; children: Snippet } = $props();

	// svelte-ignore state_referenced_locally
	const repo = setRepo(openRemote(whispering, { account }));
	// Each view follows its own client: an uploaded file leaves this device's
	// view and appears in the repository's.
	const uploader = startUploading(device, repo);
	onDestroy(() => uploader[Symbol.dispose]());
</script>

{@render children()}
