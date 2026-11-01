<!--
	Honeycrisp's store: the person's `honeycrisp` repository, for one
	account, its notes and folders set for everything under it (`setNotes`,
	`setFolders`). The parent's `{#key}` makes a new one for a new account;
	sign-out or replacement retires this one.
-->
<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { openRemote } from '@epicenter/folder/remote';
	import { fromClient } from '@epicenter/svelte/client';
	import type { Snippet } from 'svelte';
	import { honeycrisp } from '../contract.js';
	import { setFolders, setNotes } from '../honeycrisp.svelte.js';

	const { account, children }: { account: Account; children: Snippet } = $props();

	// svelte-ignore state_referenced_locally
	const files = fromClient(openRemote(honeycrisp, { account }));
	setNotes(files.notes);
	setFolders(files.folders);
</script>

{@render children()}
