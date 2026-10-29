<!--
	Open this device's Todos repository in this tab, show it, and close it
	when unmounted. The repository is one handle for the page's life: its
	status (opening, open in another tab, unavailable) shows around the app
	(`RepositoryGate`), and the app mounts once, when its todos first arrive,
	so the page hiding and showing again, or another tab taking the
	repository, never remounts it.
-->
<script lang="ts">
	import { reactive } from '@epicenter/svelte/repository';
	import RepositoryGate from '@epicenter/svelte/repository/gate';
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
		/** Open the repository in this tab. */
		open: () => Promise<Result<TodosRepository, { message: string }>>;
		/** The server this build syncs with, if any. */
		syncsTo?: string;
	} = $props();

	let opened = $state.raw<Result<TodosRepository, { message: string }>>();
	let closed = false;
	// svelte-ignore state_referenced_locally
	const opener = open;

	function start() {
		opened = undefined;
		void opener().then((result) => {
			if (closed) result.data?.close();
			else opened = result.error === null ? { data: reactive(result.data), error: null } : result;
		});
	}
	start();

	onDestroy(() => {
		closed = true;
		opened?.data?.close();
	});
</script>

{#if opened === undefined}
	<Loading class="h-dvh" label="Opening…" />
{:else if opened.error !== null}
	<Empty.Root class="h-dvh">
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Header>
			<Empty.Title>Could not open storage</Empty.Title>
			<Empty.Description role="alert">{opened.error.message}</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<Button variant="outline" size="sm" onclick={start}>Try again</Button>
		</Empty.Content>
	</Empty.Root>
{:else}
	{@const repo = opened.data}
	<RepositoryGate {repo} name="Todos">
		<TodosApp {repo} {syncsTo} />
	</RepositoryGate>
{/if}
