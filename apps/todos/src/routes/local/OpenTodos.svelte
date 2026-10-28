<!--
	Open this device's Todos repository, show it, and close it when
	unmounted. A repository applies every edit on the device at once, so
	leaving the page never waits for or asks about a save.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { onDestroy } from 'svelte';
	import type { Result } from 'wellcrafted/result';
	import type { TodosRepository } from '$lib/repository.js';
	import TodosApp from './TodosApp.svelte';

	let {
		open,
		syncsTo,
	}: {
		/** Open the repository on mount and on each Try again. */
		open: () => Promise<Result<TodosRepository, { message: string }>>;
		/** The server this build syncs with, if any. */
		syncsTo?: string;
	} = $props();

	// svelte-ignore state_referenced_locally
	let opening = $state(open());

	onDestroy(() => {
		void opening.then((result) => result.data?.close());
	});
</script>

{#await opening}
	<Loading class="h-dvh" label="Opening…" />
{:then result}
	{#if result.error}
		<Empty.Root class="h-dvh">
			<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Header>
				<Empty.Title>Could not open storage</Empty.Title>
				<Empty.Description role="alert">{result.error.message}</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<Button variant="outline" size="sm" onclick={() => { opening = open(); }}>Try again</Button>
			</Empty.Content>
		</Empty.Root>
	{:else}
		<TodosApp repo={result.data} {syncsTo} />
	{/if}
{/await}
