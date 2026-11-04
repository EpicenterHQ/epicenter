<!--
	Honeycrisp's store: the person's `honeycrisp` repository, for one
	account, read as a folder through `reactive`, its notes and folders set
	for everything under it (`setNotes`, `setFolders`). Leaving the page
	while a save is out asks first. The parent's `{#key}` makes a new one for
	a new account; sign-out or replacement retires this one.
-->
<script lang="ts">
	import type { Account } from '@epicenter/account';
	import { APPS } from '@epicenter/definition/site';
	import { folderOf } from '@epicenter/folder/core';
	import { openRemote } from '@epicenter/folder/remote';
	import { reactive } from '@epicenter/svelte/reactive';
	import type { Snippet } from 'svelte';
	import { honeycrisp } from '../contract.js';
	import { setFolders, setNotes } from '../honeycrisp.svelte.js';

	const { account, children }: { account: Account; children: Snippet } = $props();

	// svelte-ignore state_referenced_locally
	const folder = reactive(folderOf(openRemote(honeycrisp, { account, site: APPS.HONEYCRISP.url })));
	setNotes(folder.notes);
	setFolders(folder.folders);
</script>

<svelte:window
	onbeforeunload={(event) => {
		if (folder.saving()) event.preventDefault();
	}}
/>

{@render children()}
