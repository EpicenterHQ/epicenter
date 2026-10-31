<!--
	The signed-in boundary: the person's `todos` repository for everything
	under it (`getRepo`), and the uploader that moves the todos made here
	signed out or offline into it (decision 12).
-->
<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { openRemote, startUploading } from '@epicenter/folder/remote';
	import { setRepo } from '@epicenter/svelte/repo';
	import { onDestroy, type Snippet } from 'svelte';
	import { todos } from '$lib/contract.js';
	import { device } from '$lib/device.js';

	// One account for this component's life: the parent's `{#key}` makes a
	// new one for a new account, and sign-out or replacement retires this
	// repository and its uploader.
	const { account, children }: { account: Account; children: Snippet } = $props();

	// svelte-ignore state_referenced_locally
	const repo = setRepo(openRemote(todos, { account }));
	// The uploader's writes reach both sides' listeners, so the list follows it.
	const uploader = startUploading(device, repo);
	onDestroy(() => uploader[Symbol.dispose]());
</script>

{@render children()}
