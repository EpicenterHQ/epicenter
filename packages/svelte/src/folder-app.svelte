<!--
	The root of an app over its local folder: opens the browser default with
	`openFolder({ tables })` or the desktop window's handed directory with
	`openFolder({ directory, tables })` when it mounts, shows one loading screen and one
	refusal screen, provides the opened folder to its children
	(`getFolder()`), and closes it when it unmounts.

	```svelte
	<FolderApp title="Todos" tables={todosTables}><TodosView /></FolderApp>
	```

	Opening needs no account, remote, or network, and writes nothing. A
	folder that cannot open is shown as that refusal; nothing else is opened
	in its place. When the page is hidden, what is typed is sent at once.
	Importing this component opens nothing.
-->
<script lang="ts" generics="TTables extends Record<string, TSchema>">
	import { OpenFolderError, openFolder } from '@epicenter/folder';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { invoke, isTauri } from '@tauri-apps/api/core';
	import { onDestroy, type Snippet } from 'svelte';
	import type { TSchema } from 'typebox';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { createLogger } from 'wellcrafted/logger';
	import { Ok } from 'wellcrafted/result';
	import { createFolderContext } from './folder-context.js';
	import FolderProvider from './folder-provider.svelte';
	import { describeOpenRefusal, type OpenRefusal } from './open-refusal.js';
	const log = createLogger('svelte/folder-app');

	let {
		title,
		tables,
		saveAfterMs,
		children,
	}: {
		/** The app's name, as the loading and refusal screens say it. */
		title: string;
		/** The top-level directories the app reads as rows, with each row's schema. */
		tables: TTables;
		/** How long after the last keystroke a draft saves. */
		saveAfterMs?: number;
		children: Snippet;
	} = $props();

	// svelte-ignore state_referenced_locally
	async function open() {
		let opened;
		if (isTauri()) {
			const handed = await invoke<{ app: string; folder: string } | null>(
				'plugin:epicenter-folder|window_folder',
			);
			if (handed === null)
				return OpenFolderError.Unavailable({
					cause: new Error('The desktop shell did not hand this window a folder'),
				});
			opened = await openFolder({ directory: handed.folder, tables });
		} else opened = await openFolder({ tables });
		if (opened.error) return opened;
		return Ok(createFolderContext(opened.data, { saveAfterMs }));
	}
	let opening = $state(open());
	function retry() {
		opening = open();
	}

	// Teardown: what is typed is sent, every save lands, then the folder is
	// released. A folder still opening is closed once it opens.
	onDestroy(() => {
		void opening.then((opened) => opened.data?.close()).catch((cause: unknown) =>
			log.error(new Error('The local folder did not close', { cause })),
		);
	});
	function settle() {
		void opening.then((opened) => opened.data?.settled()).catch((cause: unknown) =>
			log.error(new Error('The local folder edits did not settle', { cause })),
		);
	}
</script>

<svelte:window onpagehide={settle} />
<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'hidden') settle();
	}}
/>

{#snippet refused(refusal: OpenRefusal)}
	<Empty.Root class="h-dvh">
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Header>
			<Empty.Title>{title} could not open its storage</Empty.Title>
			<Empty.Description role="alert">{refusal.description}</Empty.Description>
		</Empty.Header>
		{#if refusal.retry}
			<Empty.Content>
				<Button variant="outline" size="sm" onclick={retry}>Try again</Button>
			</Empty.Content>
		{/if}
	</Empty.Root>
{/snippet}

{#await opening}
	<Loading class="h-dvh" label="Opening {title}…" />
{:then opened}
	{#if opened.error}
		{@render refused(describeOpenRefusal(opened.error, title))}
	{:else}
		<FolderProvider context={opened.data}>{@render children()}</FolderProvider>
	{/if}
{:catch error}
	{@render refused({ description: extractErrorMessage(error), retry: true })}
{/await}
