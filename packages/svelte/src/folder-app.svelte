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
	in its place. When the page is hidden, what is typed is sent at once. A
	pending draft prompts before the browser unloads the page. In the desktop
	app, closing the window first sends what is typed and waits for it to
	save; a failed save or input the app reports as unsent keeps the window
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
	import { createLogger } from 'wellcrafted/logger';
	import { Err, Ok, type Result } from 'wellcrafted/result';
	import { createFolderContext, type FolderContext } from './folder-context.js';
	import { describeOpenRefusal, type OpenRefusal } from './open-refusal.js';
	import { toastWriteFailure } from './write-failure-toast.js';
	const log = createLogger('svelte/folder-app');

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
	// svelte-ignore state_referenced_locally
	async function openContext() {
		const { data: folder, error } = await open();
		if (error !== null) return Err(error);
		context = createFolderContext(folder);
		try {
			await context.guardWindowClose();
		} catch (cause) {
			await context.close();
			throw cause;
		}
		return Ok(context);
	}
	let opening = $state(openContext());

	// Teardown: what is typed is sent, every save lands, then the folder is
	// released. A folder still opening is closed once it opens. Input that
	// did not save is offered for copying after its editor has gone away.
	onDestroy(() => {
		void opening
			.then(async ({ data: context }) => {
				if (context === null) return;
				const unsaved = await context.close();
				for (const draft of unsaved)
					toastWriteFailure(draft);
			})
			.catch((cause: unknown) =>
				log.error(new Error('The local folder did not close', { cause })),
			);
	});
	function beforeUnload(event: BeforeUnloadEvent) {
		if (!context?.leaving) return;
		event.preventDefault();
		event.returnValue = '';
	}
	function settle() {
		void opening.then(({ data: context }) => context?.settled()).catch((cause: unknown) =>
			log.error(new Error('The local folder edits did not settle', { cause })),
		);
	}
</script>

<svelte:window onpagehide={settle} onbeforeunload={beforeUnload} />
<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'hidden') settle();
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
