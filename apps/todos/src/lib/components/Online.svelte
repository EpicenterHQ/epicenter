<!--
	The online variant's store: the person's `todos` repository, for one
	account, its todos set for everything under it (`setTodos`). The
	parent's `{#key}` makes a new one for a new account; sign-out or
	replacement retires this one.
-->
<script lang="ts">
	import type { Account } from '@epicenter/account';
	import { APPS } from '@epicenter/constants/apps';
	import { openRemote } from '@epicenter/folder/remote';
	import { fromClient } from '@epicenter/svelte/client';
	import type { Snippet } from 'svelte';
	import { todos } from '../contract.js';
	import { setTodos } from '../todos.js';

	const { account, children }: { account: Account; children: Snippet } = $props();

	// svelte-ignore state_referenced_locally
	setTodos(fromClient(openRemote(todos, { account, site: APPS.TODOS.url })).todos);
</script>

{@render children()}
