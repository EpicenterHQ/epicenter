<!--
	Vocab's store: the learner's `vocab` repository, for one account, its
	words, chats and messages set for everything under it (`setEntryList`,
	`setChatList`, `setMessageList`). The parent's `{#key}` makes a new one
	for a new account; sign-out or replacement retires this one.
-->
<script lang="ts">
	import type { Account } from '@epicenter/account';
	import { APPS } from '@epicenter/definition/site';
	import { openRemote } from '@epicenter/folder/remote';
	import { fromClient } from '@epicenter/svelte/client';
	import type { Snippet } from 'svelte';
	import { vocab } from '../contract.js';
	import { setChatList, setEntryList, setMessageList } from '../vocab.svelte.js';

	const { account, children }: { account: Account; children: Snippet } = $props();

	// svelte-ignore state_referenced_locally
	const files = fromClient(openRemote(vocab, { account, site: APPS.VOCAB.url }));
	setEntryList(files.entries);
	setChatList(files.chats);
	setMessageList(files.messages);
</script>

{@render children()}
