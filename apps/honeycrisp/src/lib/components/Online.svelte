<!--
	Honeycrisp's store: the person's `honeycrisp` repository for everything
	under it (`getRepo`), for one account. The parent's `{#key}` makes a new
	one for a new account; sign-out or replacement retires this one.
-->
<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { openRemote } from '@epicenter/folder/remote';
	import { setRepo } from '@epicenter/svelte/repo';
	import type { Snippet } from 'svelte';
	import { honeycrisp } from '../contract.js';

	const { account, children }: { account: Account; children: Snippet } = $props();

	// svelte-ignore state_referenced_locally
	setRepo(openRemote(honeycrisp, { account }));
</script>

{@render children()}
