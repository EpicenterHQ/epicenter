<!--
	The root: this page's device, always there (decision 10), and the one
	list over it. Signed in (the web build only), the signed-in subtree adds
	the person's repository, one per account.
-->
<script lang="ts">
	import { closeDevice, outboxOf } from '@epicenter/folder/browser';
	import { fromClient } from '@epicenter/svelte/client';
	import { onDestroy } from 'svelte';
	import SignedIn from '$lib/components/SignedIn.svelte';
	import TodosApp from '$lib/components/TodosApp.svelte';
	import { auth } from '$lib/auth.js';
	import { setDevice } from '$lib/context.js';
	import { isDesktop, openTodosDevice } from '$lib/device.js';
	import { createTodoList } from '$lib/todos.js';

	const client = openTodosDevice();
	const device = setDevice({ client, files: fromClient(client) });
	onDestroy(() => closeDevice(client));

	const todos = createTodoList({
		device: device.files.todos,
		repository: null,
		// The desktop's folder is Epicenter's to sync; only the browser uploads.
		outbox: isDesktop ? null : outboxOf(client),
	});
</script>

{#if isDesktop || auth.state.status === 'signed-out'}
	<TodosApp {todos} />
{:else}
	{#key auth.state.account}
		<SignedIn account={auth.state.account} />
	{/key}
{/if}
