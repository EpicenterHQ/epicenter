<!--
	The root of an app over its local folder: opens the browser origin's
	folder, or the folder the desktop shell bound to this window, with
	the app's `open` callback when it mounts,
	shows one loading screen and one
	refusal screen, passes the opened folder context to its children,
	and closes it when it unmounts.

	```svelte
	<FolderApp open={() => openFolder({ tables: todosTables })}>
		{#snippet children(context)}<TodosApp {context} />{/snippet}
	</FolderApp>
	```

	Opening needs no account, remote, or network, and writes nothing. A
	folder that cannot open is shown as that refusal; nothing else is opened
	in its place. When the page is hidden, accepted edits are sent at once.
	A pending Folder save prompts before browser unload. In the desktop app,
	closing the window uses the same status and asks whether to close anyway
	(`guardWindowClose`). Importing this component opens nothing.
-->
<script lang="ts" generics="TTables extends Record<string, TSchema>">
	import type { Folder, OpenFolderError } from '@epicenter/folder';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { onDestroy, type Snippet } from 'svelte';
	import type { TSchema } from 'typebox';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { Err, Ok, type Result } from 'wellcrafted/result';
	import { createFolderContext, type FolderContext } from './folder-context.js';
	import { describeOpenRefusal, type OpenRefusal } from './open-refusal.js';

	let {
		open,
		children,
	}: {
		/**
		 * Open a fresh folder on mount and each retry. Remount to choose
		 * another folder. The folder's open options say how it saves input.
		 */
		open: () => Promise<Result<Folder<TTables>, OpenFolderError>>;
		/** The app root installs its typed context during initialization. */
		children: Snippet<[FolderContext<TTables>]>;
	} = $props();

	let context: FolderContext<TTables> | undefined;
	let destroyed = false;
	// svelte-ignore state_referenced_locally
	async function openContext() {
		const { data: folder, error } = await open();
		if (error !== null) return Err(error);
		const openedContext = createFolderContext(folder);
		if (destroyed) {
			openedContext.close();
			return Ok(openedContext);
		}
		context = openedContext;
		try {
			await openedContext.guardWindowClose();
		} catch (cause) {
			openedContext.close();
			throw cause;
		}
		return Ok(openedContext);
	}
	let opening = $state(openContext());

	onDestroy(() => {
		destroyed = true;
		context?.close();
		void opening.catch(() => {});
	});
	function beforeUnload(event: BeforeUnloadEvent) {
		if (!context || (!context.getStatus().saving && context.getStatus().unsaved.length === 0)) return;
		event.preventDefault();
		event.returnValue = '';
	}
	function flush() {
		if (context && !context.getStatus().closing) context.folder.flush();
	}
</script>

<svelte:window onpagehide={flush} onbeforeunload={beforeUnload} />
<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'hidden') flush();
	}}
/>

{#snippet refused(refusal: OpenRefusal)}
	<Empty.Root class="h-dvh">
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Header>
			<Empty.Title>Could not open storage</Empty.Title>
			<Empty.Description role="alert">{refusal.description}</Empty.Description>
		</Empty.Header>
		{#if refusal.retry}
			<Empty.Content>
				<Button variant="outline" size="sm" onclick={() => { opening = openContext(); }}>Try again</Button>
			</Empty.Content>
		{/if}
	</Empty.Root>
{/snippet}

{#await opening}
	<Loading class="h-dvh" label="Opening…" />
{:then opened}
	{#if opened.error}
		{@render refused(describeOpenRefusal(opened.error))}
	{:else}
		{@render children(opened.data)}
	{/if}
{:catch error}
	{@render refused({ description: extractErrorMessage(error), retry: true })}
{/await}
