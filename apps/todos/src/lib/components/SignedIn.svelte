<!--
	Signed in: the person's `todos` repository beside this browser's files,
	as one list, and the uploader that moves the todos made here signed out
	or offline into the repository (decision 12).
-->
<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { outboxOf } from '@epicenter/folder/browser';
	import { openRemote, startUploading } from '@epicenter/folder/remote';
	import { fromClient } from '@epicenter/svelte/client';
	import { onDestroy } from 'svelte';
	import { todos as contract } from '$lib/contract.js';
	import { getDevice } from '$lib/context.js';
	import { createTodoList } from '$lib/todos.js';
	import TodosApp from './TodosApp.svelte';

	// One account for this component's life: the parent's `{#key}` makes a
	// new one for a new account, and sign-out or replacement retires this
	// remote and its uploader.
	const { account }: { account: Account } = $props();

	const device = getDevice();
	// svelte-ignore state_referenced_locally
	const remote = openRemote(contract, { account });
	const todos = createTodoList({
		device: device.files.todos,
		repository: fromClient(remote).todos,
		outbox: outboxOf(device.client),
	});
	// The uploader's writes reach both sides' listeners, so the list follows it.
	const uploader = startUploading(device.client, remote);
	onDestroy(() => uploader[Symbol.dispose]());
</script>

<TodosApp {todos} />
