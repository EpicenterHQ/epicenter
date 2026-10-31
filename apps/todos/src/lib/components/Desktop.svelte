<!--
	The desktop variant's root: Todos over the folder the shell bound to this
	window (`openDevice` from `@epicenter/folder/tauri`), opened before it
	renders, under the page's boundary. Epicenter syncs that folder; the page
	never signs in.
-->
<script lang="ts">
	import { openDevice } from '@epicenter/folder/tauri';
	import { fromClient } from '@epicenter/svelte/client';
	import * as Alert from '@epicenter/ui/alert';
	import { todos } from '$lib/contract.js';
	import TodosApp from './TodosApp.svelte';

	const device = await openDevice(todos);
</script>

{#if device.error !== null}
	<main class="mx-auto flex w-full max-w-xl flex-col gap-5 px-6 py-12">
		<Alert.Root variant="destructive">
			<Alert.Title>Todos could not open its folder</Alert.Title>
			<Alert.Description class="break-all">{device.error.message}</Alert.Description>
		</Alert.Root>
	</main>
{:else}
	<TodosApp variant="desktop" todos={fromClient(device.data).todos} />
{/if}
