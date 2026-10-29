<!--
	A repository's status around the app that shows it. Until the
	repository's notes first arrive, the status is the page: opening,
	waiting for another tab's worker to let go, open in another tab (Use
	here), or unavailable (Try again). From then on the app stays mounted
	for as long as this does, and the status is a bar above it: the page
	hiding and showing again, or another tab taking the repository, never
	remounts the app, so its controls, editors and typing stay where they
	are. While the bar shows, the repository saves nothing and says so.

	```svelte
	<RepositoryGate {repo} name="Todos">
		<TodosApp {repo} />
	</RepositoryGate>
	```
-->
<script lang="ts">
	import type { RepositoryStatus } from '@epicenter/repository/api';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import AppWindowIcon from '@lucide/svelte/icons/app-window';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { Snippet } from 'svelte';

	let {
		repo,
		name,
		children,
	}: {
		/** The repository, its status tracked (`reactive`). */
		repo: { status(): RepositoryStatus };
		/** The app's name, as the person knows it. */
		name: string;
		children: Snippet;
	} = $props();

	const status = $derived(repo.status());
	/** Whether the notes have arrived once: from then on the app stays mounted. */
	let arrived = false;
	const mounted = $derived.by(() => (arrived ||= status.status === 'open'));
</script>

{#if mounted}
	<div class="flex h-dvh flex-col overflow-hidden">
		{#if status.status !== 'open'}
			<div
				class="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted px-3 py-2 text-sm"
				role="status"
				data-testid="repository-status"
				data-status={status.status}
			>
				{#if status.status === 'opening' || status.status === 'waiting'}
					<span class="text-muted-foreground">Opening {name} again; changes are saved once it is open.</span>
				{:else if status.status === 'elsewhere' || status.status === 'moved'}
					{@const useHere = status.useHere}
					<span>{name} is open in another tab, so nothing here is saved.</span>
					<Button size="sm" onclick={() => useHere()}>Use here</Button>
				{:else if status.status === 'unavailable'}
					{@const retry = status.retry}
					<span class="text-destructive">Could not open storage: {status.reason}</span>
					<Button size="sm" variant="outline" onclick={() => retry()}>Try again</Button>
				{:else}
					<span class="text-muted-foreground">{name} is closed.</span>
				{/if}
			</div>
		{/if}
		<div class="min-h-0 flex-1">{@render children()}</div>
	</div>
{:else if status.status === 'opening' || status.status === 'closed'}
	<Loading class="h-dvh" label="Opening…" />
{:else if status.status === 'waiting'}
	<Loading class="h-dvh" label="Waiting for the other tab to let go…" />
{:else if status.status === 'elsewhere' || status.status === 'moved'}
	{@const useHere = status.useHere}
	<Empty.Root class="h-dvh">
		<Empty.Media><AppWindowIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Header>
			<Empty.Title>{status.status === 'moved' ? `${name} moved to another tab` : `${name} is open in another tab`}</Empty.Title>
			<Empty.Description>{name} works in one tab at a time. Use it here, and the other tab stops.</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<Button size="sm" onclick={() => useHere()}>Use here</Button>
		</Empty.Content>
	</Empty.Root>
{:else if status.status === 'unavailable'}
	{@const retry = status.retry}
	<Empty.Root class="h-dvh">
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Header>
			<Empty.Title>Could not open storage</Empty.Title>
			<Empty.Description role="alert">{status.reason}</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<Button variant="outline" size="sm" onclick={() => retry()}>Try again</Button>
		</Empty.Content>
	</Empty.Root>
{/if}
