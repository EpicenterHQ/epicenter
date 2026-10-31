<!--
	The signed-in boundary: the learner's `vocab` repository for everything
	under it (`getRepo`, read by the "Synced" page), and the uploader that
	moves every word, chat and message on this device into it (decisions 12
	and 76).
-->
<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { openRemote, startUploading } from '@epicenter/folder/remote';
	import { setRepo } from '@epicenter/svelte/repo';
	import { onDestroy, type Snippet } from 'svelte';
	import { vocab } from '$lib/contract.js';
	import { device } from '$lib/device.js';

	// One account for this component's life: the layout's `{#key}` makes a
	// new one for a new account, and sign-out or replacement retires this
	// repository and its uploader.
	const { account, children }: { account: Account; children: Snippet } = $props();

	// svelte-ignore state_referenced_locally
	const repo = setRepo(openRemote(vocab, { account }));
	// Each view follows its own client: an uploaded word leaves this device's
	// and appears in the repository's.
	const uploader = startUploading(device, repo);
	onDestroy(() => uploader[Symbol.dispose]());
</script>

{@render children()}
