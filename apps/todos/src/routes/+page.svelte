<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { createClosing } from '@epicenter/svelte/closing';
	import ClosingNotice from '@epicenter/svelte/closing-notice';
	import { onDestroy } from 'svelte';
	import { createLogger } from 'wellcrafted/logger';
	import { Ok } from 'wellcrafted/result';
	import { openTodosFolder } from '#platform/folder';
	import { onCloseRequested } from '#platform/window';
	import { createTodos, type Todos } from '$lib/todos.svelte.js';
	import TodosView from './components/TodosView.svelte';

	const log = createLogger('todos/page');

	// The mounted page acquires the folder; importing modules opens nothing.
	// Which folder is the build's choice: a browser folder, or the desktop
	// host's directory. A folder that cannot be opened is shown as that
	// refusal; nothing else is opened in its place.
	//
	// Ending the page is `close`, however it ends: it refuses new work, lets
	// running work and saves finish, and releases the folder. The window's
	// close handler awaits it before the window goes, and unmounting calls it
	// too. Before the todos exist there is nothing to wait for, so a close
	// while opening, or after the folder was refused, goes ahead at once.
	let todos: Todos | undefined;
	async function close() {
		await todos?.close();
	}
	// The handler waits with no timeout. A close still running after a moment
	// shows "Still saving…" with Close anyway, which lets the window go.
	const closing = createClosing({ close });
	const listening = onCloseRequested?.(closing.request).catch((cause: unknown) => {
		log.warn(new Error('Listening for the window to close failed.', { cause }));
		return undefined;
	});
	const opening = (async () => {
		// The handler is registered before anything can be edited.
		await listening;
		const opened = await openTodosFolder();
		if (opened.error) return opened;
		todos = createTodos(opened.data);
		return Ok(todos);
	})().then(async (opened) => {
		await opened.data?.check();
		return opened;
	});

	onDestroy(() => {
		void listening?.then((stop) => stop?.());
		void opening.then(close).catch(() => {});
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

<ClosingNotice {closing} />
