<!--
	Open this device's Honeycrisp repository in this tab, show it, and close it
	when unmounted. One tab owns the repository at a time: another tab
	offers Use here, and a tab whose repository was taken says so and waits
	to be asked. A repository applies every edit on the device at once, so
	leaving the page never waits for or asks about a save.
-->
<script lang="ts">
	import { live } from '@epicenter/repository/svelte';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import AppWindowIcon from '@lucide/svelte/icons/app-window';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { onDestroy } from 'svelte';
	import type { HoneycrispTab } from '$lib/repository.js';
	import HoneycrispApp from './HoneycrispApp.svelte';

	let {
		open,
		syncsTo,
	}: {
		/** Open the repository in this tab, once, on mount. */
		open: () => HoneycrispTab;
		/** The server this build syncs with, if any. */
		syncsTo?: string;
	} = $props();

	// svelte-ignore state_referenced_locally
	const tab = open();
	const held = live(tab);

	onDestroy(() => tab.close());
</script>

{#if held.current === undefined || held.current.status === 'opening' || held.current.status === 'closed'}
	<Loading class="h-dvh" label="Opening…" />
{:else if held.current.status === 'waiting'}
	<Loading class="h-dvh" label="Waiting for the other tab to let go…" />
{:else if held.current.status === 'elsewhere' || held.current.status === 'moved'}
	{@const useHere = held.current.useHere}
	<Empty.Root class="h-dvh">
		<Empty.Media><AppWindowIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Header>
			<Empty.Title>{held.current.status === 'moved' ? 'Honeycrisp moved to another tab' : 'Honeycrisp is open in another tab'}</Empty.Title>
			<Empty.Description>Honeycrisp works in one tab at a time. Use it here, and the other tab stops.</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<Button size="sm" onclick={() => useHere()}>Use here</Button>
		</Empty.Content>
	</Empty.Root>
{:else if held.current.status === 'unavailable'}
	{@const retry = held.current.retry}
	<Empty.Root class="h-dvh">
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Header>
			<Empty.Title>Could not open storage</Empty.Title>
			<Empty.Description role="alert">{held.current.error.message}</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<Button variant="outline" size="sm" onclick={() => retry()}>Try again</Button>
		</Empty.Content>
	</Empty.Root>
{:else}
	{#key held.current.repository}
		<HoneycrispApp repo={held.current.repository} {syncsTo} />
	{/key}
{/if}
