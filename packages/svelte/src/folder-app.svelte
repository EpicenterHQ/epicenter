<!--
	The root of a folder app: opens the app's folder when it mounts, shows one
	loading screen and one refusal screen, provides the opened folder to its
	children (`getFolder()`), shows every failed save as one toast that offers
	the unsaved text, and closes the folder when it unmounts (ADR-0574).

	```svelte
	<FolderApp app={manifest} definition={todosDefinition}>
		<TodosView />
	</FolderApp>
	```

	`openFolder` from `@epicenter/folder` picks the host when it is called: in
	the desktop app, the folder the shell handed this window; in a browser,
	the app's own. Only the app's own folder has its definition published
	(ADR-0583). A folder that cannot open is shown as that refusal; nothing
	else is opened in its place. Importing this component opens nothing.
-->
<script lang="ts" generics="TDefinition extends Definition">
	import {
		type BrowserFolderOptions,
		type Definition,
		openFolder,
	} from '@epicenter/folder';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { onDestroy, type Snippet } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { Ok } from 'wellcrafted/result';
	import { createFolderContext } from './folder-context.js';
	import FolderProvider from './folder-provider.svelte';
	import { describeOpenRefusal, type OpenRefusal } from './open-refusal.js';
	import { toastWriteFailure } from './write-failure-toast.js';

	let {
		app,
		definition,
		browser,
		children,
	}: {
		/** The app's manifest (`epicenter.app.json`): its id names its own folder. */
		app: { readonly id: string; readonly title: string };
		/** The app's tables. Published only to the app's own folder. */
		definition: TDefinition;
		/**
		 * A browser folder's settings, such as an `httpFetch` for Sync. The
		 * commit author defaults to the app's title. The desktop app ignores
		 * them.
		 */
		browser?: BrowserFolderOptions;
		children: Snippet;
	} = $props();

	// Opening starts when the root mounts, and writes nothing. Quitting the
	// desktop app asks this page nothing (ADR-0542).
	// svelte-ignore state_referenced_locally
	const opening = (async () => {
		const opened = await openFolder({
			app: app.id,
			definition,
			browser: {
				author: { name: app.title, email: `${app.id}@localhost` },
				...browser,
			},
		});
		if (opened.error) return opened;
		return Ok(
			createFolderContext(opened.data, { writeFailed: toastWriteFailure }),
		);
	})();

	// Teardown, not a choice about input: it runs when the page is destroyed.
	// Closing waits for every write and action, then releases the folder. A
	// folder still opening is closed once it opens.
	onDestroy(() => {
		void opening.then((opened) => opened.data?.close()).catch(() => {});
	});
</script>

{#snippet refused(refusal: OpenRefusal)}
	<Empty.Root class="h-dvh">
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Header>
			<Empty.Title>{app.title} could not open its folder</Empty.Title>
			<Empty.Description role="alert">{refusal.description}</Empty.Description>
		</Empty.Header>
		{#if refusal.retry}
			<Empty.Content>
				<Button variant="outline" size="sm" onclick={() => location.reload()}>Try again</Button>
			</Empty.Content>
		{/if}
	</Empty.Root>
{/snippet}

{#await opening}
	<Loading class="h-dvh" label={`Opening ${app.title}…`} />
{:then opened}
	{#if opened.error}
		{@render refused(describeOpenRefusal(opened.error, app.title))}
	{:else}
		<FolderProvider context={opened.data}>{@render children()}</FolderProvider>
	{/if}
{:catch error}
	{@render refused({ description: extractErrorMessage(error), retry: true })}
{/await}
