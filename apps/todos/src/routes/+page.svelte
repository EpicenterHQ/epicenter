<script lang="ts">
	import { flushOnClose } from '@epicenter/svelte/flush-on-close';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { onDestroy } from 'svelte';
	import { Ok } from 'wellcrafted/result';
	import { hostClose } from '#platform/close';
	import { openTodosFolder } from '#platform/folder';
	import { createTodos } from '$lib/todos.svelte.js';
	import TodosView from './components/TodosView.svelte';

	// The mounted page acquires the folder; importing modules opens nothing.
	// Which folder is the build's choice: a browser folder, or the desktop
	// host's directory. A folder that cannot be opened is shown as that
	// refusal; nothing else is opened in its place.
	//
	// Once the todos exist, closing gives their saves in flight a bounded
	// moment: on Epicenter's flush before it quits or restarts, and on
	// `pagehide`. Nothing is asked.
	let stopFlushing: (() => void) | undefined;
	const opening = (async () => {
		const opened = await openTodosFolder();
		return opened.error ? opened : Ok(createTodos(opened.data));
	})().then(async (opened) => {
		const todos = opened.data;
		if (todos) stopFlushing = flushOnClose(() => todos.flush(), { hostClose });
		await todos?.check();
		return opened;
	});

	// Teardown, not a choice about input. It runs when SvelteKit destroys this
	// page, which TodosView's beforeNavigate refuses while anything is
	// unsaved; closing or hiding the window, quitting, and a host restart
	// never run it. `close` saves what may save and names what it could not.
	onDestroy(() => {
		stopFlushing?.();
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
	<Loading class="h-dvh" label="Opening your todos…" />
{:then opened}
	{#if opened.error}
		{@render refused(opened.error.message)}
	{:else}
		<TodosView todos={opened.data} />
	{/if}
{:catch error}
	{@render refused(error instanceof Error ? error.message : String(error))}
{/await}
