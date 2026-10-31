<!--
	Whispering's web startup (decision 94): this browser's files (OPFS,
	`openDevice` from `@epicenter/folder/browser`), opened before any page
	renders; the layout's boundary shows the spinner until they are. The
	recordings stay here for good: they never sync and never upload, and
	signing in moves nothing (ADR-0700). A browser that keeps no files still
	opens, and the app says so; a page with no Worker to keep them opens
	nothing.
-->
<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import { closeDevice, openDevice } from '@epicenter/folder/browser';
	import * as Alert from '@epicenter/ui/alert';
	import { onDestroy, type Snippet } from 'svelte';
	import { type Whispering, whispering } from '$lib/contract.js';
	import WhisperingApp from './WhisperingApp.svelte';

	let { children }: { children: Snippet } = $props();

	// Registered before the await, which ends the component's setup.
	let opened: Client<Whispering> | undefined;
	onDestroy(() => {
		if (opened !== undefined) closeDevice(opened);
	});
	const device = await openDevice(whispering);
	if (device.error === null) opened = device.data;
</script>

{#if device.error !== null}
	<main class="mx-auto flex w-full max-w-xl flex-col gap-5 px-6 py-12">
		<Alert.Root variant="destructive">
			<Alert.Title>Whispering could not open this browser's files</Alert.Title>
			<Alert.Description>{device.error.message}</Alert.Description>
		</Alert.Root>
	</main>
{:else}
	<WhisperingApp client={device.data}>{@render children()}</WhisperingApp>
{/if}
