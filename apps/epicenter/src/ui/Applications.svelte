<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
	import { Loading } from '@epicenter/ui/loading';
	import type { Application } from '../applications.ts';
	import { APPLICATIONS_ROUTE } from '../routes.ts';
	import type { ApplicationsResponse } from '../server.ts';
	import { createLaunch } from './launch.svelte.ts';
	import { isDesktopHost } from './runtime.ts';

	/**
	 * Everything a person can launch, in one list (ADR-0189).
	 *
	 * The host composes the list, so there is nothing here that knows whether a
	 * row is compiled into the release or is a member of the selected catalog
	 * generation: one row shape, one action, one order. A row carries only the
	 * ID and title the host honestly derived, which is why there are no
	 * descriptions, icons, categories, or running indicators to invent.
	 */

	const { ready }: { ready: Promise<void> } = $props();

	// `null` off the desktop: nothing here can open a window there, so nothing
	// here asks the host for a list it could not act on either.
	// The bootstrap promise is fixed for this document lifetime.
	// svelte-ignore state_referenced_locally
	const applications = isDesktopHost() ? ready.then(readApplications) : null;
	const launcher = createLaunch();

	async function readApplications(): Promise<Application[]> {
		const response = await fetch(APPLICATIONS_ROUTE.url(location.origin));
		if (!response.ok) {
			throw new Error(`Epicenter answered ${response.status}.`);
		}
		return ((await response.json()) as ApplicationsResponse).apps;
	}
</script>

{#if applications !== null}
	{#await applications}
		<Loading class="h-full" label="Loading apps" />
	{:then list}
		<div class="grid gap-3 p-3">
			{#if launcher.failure}
				<Alert.Root variant="destructive">
					<Alert.Title>Could not open</Alert.Title>
					<Alert.Description>{launcher.failure}</Alert.Description>
				</Alert.Root>
			{/if}
			<Item.Group class="gap-1.5" aria-label="Apps">
				{#each list as application (application.id)}
					<Item.Button
						variant="outline"
						class="text-start hover:bg-accent/50"
						onclick={() => void launcher.launch(application)}
					>
						<Item.Content>
							<Item.Title>{application.title}</Item.Title>
						</Item.Content>
					</Item.Button>
				{/each}
			</Item.Group>
		</div>
	{:catch error}
		<Alert.Root variant="destructive" class="m-3 w-auto">
			<Alert.Title>Could not load apps</Alert.Title>
			<Alert.Description>
				{error instanceof Error ? error.message : String(error)}
			</Alert.Description>
		</Alert.Root>
	{/await}
{:else}
	<Empty.Root class="h-full border-0">
		<Empty.Header>
			<Empty.Title>Apps open on the desktop</Empty.Title>
			<Empty.Description>
				This Home is showing the session from a browser. Apps open in their own
				windows on the machine running Epicenter.
			</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{/if}
