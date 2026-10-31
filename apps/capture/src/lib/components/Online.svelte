<!--
	Capture's store: the person's `capture` repository for everything under
	it (`getRepo`), for one account. The parent's `{#key}` makes a new one
	for a new account; sign-out or replacement retires this one.
-->
<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { capture } from '@epicenter/capture';
	import { openRemote } from '@epicenter/folder/remote';
	import { fromClient } from '@epicenter/svelte/client';
	import { setRepo } from '@epicenter/svelte/repo';
	import type { Snippet } from 'svelte';

	const { account, children }: { account: Account; children: Snippet } = $props();

	// svelte-ignore state_referenced_locally
	setRepo(fromClient(openRemote(capture, { account })));
</script>

{@render children()}
