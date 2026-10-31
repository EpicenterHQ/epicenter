<!--
	The signed-in boundary: the person's `whispering` repository for
	everything under it (`getRepo`), and the uploader that moves what was
	made here, signed out or offline, into it (decision 12). Recordings made
	signed out upload to whoever signs in next on this browser (decision 67).
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
	// The uploader's writes reach both sides' listeners, so the lists follow it.
	const uploader = startUploading(device, repo);
	onDestroy(() => uploader[Symbol.dispose]());
</script>

{@render children()}
