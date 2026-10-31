<!--
	Messages' startup (decision 94): this browser's files (OPFS, `openDevice`
	from `@epicenter/folder/browser`), opened before the app renders; the
	layout's boundary shows the spinner until they are. A browser that keeps
	no files still opens, and the drafts say so; a page with no Worker to
	keep them opens nothing.
-->
<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import { closeDevice, openDevice } from '@epicenter/folder/browser';
	import * as Alert from '@epicenter/ui/alert';
	import { onDestroy } from 'svelte';
	import { type Messages, messages } from './contract.js';
	import MessagesApp from './MessagesApp.svelte';

	// Registered before the await, which ends the component's setup.
	let opened: Client<Messages> | undefined;
	onDestroy(() => {
		if (opened !== undefined) closeDevice(opened);
	});
	const device = await openDevice(messages);
	if (device.error === null) opened = device.data;
</script>

{#if device.error !== null}
	<main class="mx-auto flex w-full max-w-xl flex-col gap-5 px-6 py-12">
		<Alert.Root variant="destructive">
			<Alert.Title>Messages could not open this browser's files</Alert.Title>
			<Alert.Description>{device.error.message}</Alert.Description>
		</Alert.Root>
	</main>
{:else}
	<MessagesApp device={device.data} />
{/if}
