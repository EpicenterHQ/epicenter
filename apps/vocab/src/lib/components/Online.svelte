<!--
	Vocab's store: the learner's `vocab` repository, for one account, read as
	a folder (`folderOf`) through `reactive`, its words, chats and messages
	set for everything under it (`setEntryList`, `setChatList`,
	`setMessageList`). Leaving the page while a word or chat save is out
	(`saving()`) asks first. The parent's `{#key}` makes a new one for a new
	account; sign-out or replacement retires this one.
-->
<script lang="ts">
	import type { Account } from '@epicenter/account';
	import { APPS } from '@epicenter/definition/site';
	import { folderOf } from '@epicenter/folder/core';
	import { openRemote } from '@epicenter/folder/remote';
	import { reactive } from '@epicenter/svelte/reactive';
	import { onMount, type Snippet } from 'svelte';
	import { on } from 'svelte/events';
	import { vocab } from '../contract.js';
	import { setChatList, setEntryList, setMessageList } from '../vocab.svelte.js';

	const { account, children }: { account: Account; children: Snippet } = $props();

	// svelte-ignore state_referenced_locally
	const client = openRemote(vocab, { account, site: APPS.VOCAB.url });
	const folder = reactive(folderOf(client));
	setEntryList(folder.entries);
	setChatList(folder.chats);
	setMessageList(client.messages);

	onMount(() =>
		on(window, 'beforeunload', (event) => {
			if (folder.saving()) event.preventDefault();
		}),
	);
</script>

{@render children()}
