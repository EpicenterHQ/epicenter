<!--
	Vocab's store: the learner's `vocab` repository for everything under it
	(`getRepo`), for one account. The parent's `{#key}` makes a new one for a
	new account; sign-out or replacement retires this one.
-->
<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { openRemote } from '@epicenter/folder/remote';
	import { setRepo } from '@epicenter/svelte/repo';
	import type { Snippet } from 'svelte';
	import { vocab } from '../contract.js';

	const { account, children }: { account: Account; children: Snippet } = $props();

	// svelte-ignore state_referenced_locally
	setRepo(openRemote(vocab, { account }));
</script>

{@render children()}
