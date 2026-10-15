<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { onDestroy } from 'svelte';
	import { Ok } from 'wellcrafted/result';
	import { openTodosFolder } from '#platform/folder';
	import { describeError } from '$lib/describe-error.js';
	import type { WriteFailure } from '$lib/session.js';
	import { createTodos } from '$lib/todos.svelte.js';
	import TodosView from './components/TodosView.svelte';

	/** A save failed; the editor keeps the edit. Say so, and offer it as text. */
	function writeFailed({ path, error, unsaved }: WriteFailure) {
		toast.error(`Could not save ${path}`, {
			description: describeError(error),
			action:
				unsaved === ''
					? undefined
					: {
							label: 'Copy your text',
							onClick: () => void navigator.clipboard.writeText(unsaved).catch(() => {}),
						},
		});
	}

	// The mounted page acquires the folder; importing modules opens nothing,
	// and opening writes nothing. Inside Epicenter it is the desktop host's
	// directory; in a browser, this browser's own folder for Todos, which its
	// first todo creates. A folder that cannot be opened is shown as that
	// refusal; nothing else is opened in its place. Quitting Epicenter asks
	// this page nothing (ADR-0542).
	const opening = (async () => {
		const opened = await openTodosFolder();
		if (opened.error) return opened;
		const { folder, own } = opened.data;
		return Ok({ todos: createTodos(folder, { onWriteFailed: writeFailed }), own });
	})();

	// Teardown, not a choice about input. It runs when SvelteKit destroys this
	// page, which TodosView's beforeNavigate refuses while a write or action
	// runs; closing or hiding the window, quitting,
	// and a host restart never run it. `close` waits for every write and
	// action, then releases the folder.
	onDestroy(() => {
		void opening.then((opened) => opened.data?.todos.close()).catch(() => {});
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
	<Loading class="h-dvh" label="Opening your todos…" />
{:then opened}
	{#if opened.error}
		{@render refused(opened.error.message)}
	{:else}
		<TodosView todos={opened.data.todos} canConnect={opened.data.own} />
	{/if}
{:catch error}
	{@render refused(error instanceof Error ? error.message : String(error))}
{/await}
