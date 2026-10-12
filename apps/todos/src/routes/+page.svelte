<script lang="ts">
	import {
		createDeparture,
		openForDeparture,
	} from '@epicenter/epicenter/departure/page';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { onDestroy } from 'svelte';
	import { Ok } from 'wellcrafted/result';
	import { departurePort } from '#platform/departure';
	import { openTodosFolder } from '#platform/folder';
	import { describeError } from '$lib/describe-error.js';
	import type { WriteFailure } from '$lib/session.js';
	import { createTodos } from '$lib/todos.svelte.js';
	import FolderScope from './components/FolderScope.svelte';
	import TodosView from './components/TodosView.svelte';

	// Inside Epicenter, quitting or restarting asks this page first; a browser
	// build has no port and keeps its own leave warning.
	const departure =
		departurePort === undefined ? undefined : createDeparture(departurePort);
	void departure?.start();

	/** A write that failed was rolled back to the file; say so, and offer the text it held. */
	function writeFailed({ path, error, lost }: WriteFailure) {
		toast.error(`Could not save ${path}`, {
			description: describeError(error),
			action:
				lost === ''
					? undefined
					: {
							label: 'Copy your text',
							onClick: () => void navigator.clipboard.writeText(lost).catch(() => {}),
						},
		});
	}

	// The mounted page acquires the folder; importing modules opens nothing.
	// Which folder is the build's choice: a browser folder, or the desktop
	// host's directory. A folder that cannot be opened is shown as that
	// refusal; nothing else is opened in its place.
	//
	// Inside Epicenter, the folder opens only once a status from the host is
	// known, so nothing is editable while a quit or restart may be running,
	// and the store is attached before anything else is awaited. Until then a
	// failure to listen or read keeps the page here, unopened, with Retry; a
	// later nudge or focus that reads the status opens it too. A folder that
	// does not open answers a departure ready.
	const opening = openForDeparture(
		departure,
		async () => {
			const opened = await openTodosFolder();
			return opened.error
				? opened
				: Ok(createTodos(opened.data, { onWriteFailed: writeFailed }));
		},
		(opened) => opened.data?.departure,
	);

	// Teardown, not a choice about input. It runs when SvelteKit destroys this
	// page, which TodosView's beforeNavigate refuses while a write or action
	// runs or repair text is unsaved; closing or hiding the window, quitting,
	// and a host restart never run it. `close` waits for every write and
	// action, then releases the folder.
	onDestroy(() => {
		departure?.destroy();
		void opening.then((opened) => opened.data?.close()).catch(() => {});
	});
</script>

{#snippet refused(message: string)}
	<Empty.Root class="h-dvh">
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Title>Could not open the todos folder</Empty.Title>
		<Empty.Description>{message}</Empty.Description>
	</Empty.Root>
{/snippet}

{#await opening}
	{#if departure !== undefined && !departure.known && departure.problem !== undefined}
		<Empty.Root class="h-dvh">
			<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>Todos is waiting for Epicenter</Empty.Title>
			<Empty.Description>
				Todos opens once it can tell whether Epicenter is quitting or restarting, so nothing you type is lost to one. {departure.problem}
			</Empty.Description>
			<Button variant="outline" size="sm" onclick={() => void departure.start()}>Retry</Button>
		</Empty.Root>
	{:else}
		<Loading class="h-dvh" label="Opening your todos…" />
	{/if}
{:then opened}
	{#if opened.error}
		{@render refused(opened.error.message)}
	{:else}
		<FolderScope todos={opened.data}>
			<TodosView {departure} />
		</FolderScope>
	{/if}
{:catch error}
	{@render refused(error instanceof Error ? error.message : String(error))}
{/await}
