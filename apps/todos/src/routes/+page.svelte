<!--
	The root: this page's device, always there (decision 10), and the one
	list over it. Signed in (the web build only), the signed-in subtree adds
	the person's repository, one per account.
-->
<script lang="ts">
	import { closeDevice, outboxOf } from '@epicenter/folder/browser';
	import { fromClient } from '@epicenter/svelte/client';
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onDestroy, onMount } from 'svelte';
	import SignedIn from '$lib/components/SignedIn.svelte';
	import TodosApp from '$lib/components/TodosApp.svelte';
	import { webAuth } from '$lib/auth.js';
	import { setDevice } from '$lib/context.js';
	import { isDesktop, openTodosDevice } from '$lib/device.js';
	import { createTodoList } from '$lib/todos.js';

	const auth = webAuth();
	const client = openTodosDevice();
	const device = setDevice({ client, files: fromClient(client) });
	onDestroy(() => closeDevice(client));
	// Leaving while a save is out asks first; a desktop window waits for it.
	onMount(guardLeave);

	const todos = createTodoList({
		device: device.files.todos,
		repository: null,
		// The desktop's folder is Epicenter's to sync; only the browser uploads.
		outbox: isDesktop ? null : outboxOf(client),
	});
</script>

{#if auth === null || auth.state.status === 'signed-out'}
	<TodosApp {todos} />
{:else}
	{#key auth.state.account}
		<SignedIn account={auth.state.account} />
	{/key}
{/if}
