<!--
	The owner of one opened folder's lifetime, at any depth: an app's root, or
	a settings pane over its own folder. Below it the folder is open, read, and
	reactive; nothing there handles "not open yet".

	```svelte
	<OpenFolder open={() => openFolder({ tables })}>
		{#snippet children(folder)}<NotesApp {folder} />{/snippet}
	</OpenFolder>
	```

	It opens with `open` when it mounts (and on each retry), shows one loading
	screen and one refusal screen, and hands its children the folder wrapped
	by `svelteFolder`. It looks at storage again, and sends waiting writes, on
	focus, on becoming visible or hidden, on coming back online, and before
	the page hides. Each write that does not land is a toast with the text to
	copy. A desktop window's close waits for writes in flight when guarded;
	a browser unload asks only while a write is out. When it unmounts, it
	closes the folder.
-->
<script lang="ts" generics="TTables extends Record<string, TSchema>">
	import type { Folder, Opened, SaveFailure } from '@epicenter/folder/next';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { onDestroy, type Snippet } from 'svelte';
	import type { TSchema } from 'typebox';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { createLogger } from 'wellcrafted/logger';
	import { Ok } from 'wellcrafted/result';
	import { type SvelteFolder, svelteFolder } from './folder-next.js';
	import { describeOpenRefusal, type OpenRefusal } from './open-refusal.js';
	import { describeWriteError } from './write-failure.js';
	import { holdWindowClose as registerWindowClose } from './window-close.js';

	let {
		open,
		children,
		holdWindowClose = true,
		class: className = 'h-dvh',
	}: {
		/** Open a fresh folder on mount and each retry. Remount to choose another. */
		open: () => Opened<TTables>;
		children: Snippet<[SvelteFolder<TTables>]>;
		/** Settings windows hide instead of closing and cannot destroy themselves. */
		holdWindowClose?: boolean;
		/** Height for the loading and refusal screens; defaults to `h-dvh`. */
		class?: string;
	} = $props();

	const log = createLogger('svelte/open-folder');

	let opened: Folder<TTables> | undefined;
	let stopWindow: (() => void) | undefined;
	let stopFailed: (() => void) | undefined;
	const failureToasts = new Map<string, string | number>();
	let destroyed = false;

	const saving = () => opened?.saving() ?? false;

	/** Say a write did not land, with the text it tried to save to copy. */
	function toastFailure(failure: SaveFailure) {
		log.error(failure.error);
		const previous = failureToasts.get(failure.path);
		if (previous !== undefined) toast.dismiss(previous);
		const shown = toast.error(`Could not save ${failure.path}`, {
			description: describeWriteError(failure.error),
			duration: failure.text === undefined ? undefined : Number.POSITIVE_INFINITY,
			action: failure.text === undefined ? undefined : {
				label: 'Copy your text',
				onClick: () => {
					if (failure.text !== undefined) void navigator.clipboard.writeText(failure.text);
				},
			},
		});
		failureToasts.set(failure.path, shown);
	}

	async function openAndWrap() {
		const result = await open();
		if (result.error !== null) return result;
		const folder = result.data;
		if (destroyed) {
			void folder.close();
			return Ok(svelteFolder(folder));
		}
		opened = folder;
		stopFailed = folder.onFailed(toastFailure);
		// One guard per window: a folder opened beneath another leaves the
		// window's close to the outer one. It never asks: it waits for the
		// writes in flight, which answer in milliseconds.
		if (holdWindowClose) {
			const stop = await registerWindowClose(
				() => false,
				() => {},
				() => folder.close(),
			).catch(() => undefined);
			if (destroyed) stop?.();
			else stopWindow = stop;
		}
		return Ok(svelteFolder(folder));
	}
	let opening = $state(openAndWrap());

	onDestroy(() => {
		destroyed = true;
		stopWindow?.();
		stopFailed?.();
		void opened?.close();
		void opening.catch(() => {});
	});

	function beforeUnload(event: BeforeUnloadEvent) {
		opened?.checkpoint();
		if (!saving()) return;
		event.preventDefault();
		event.returnValue = '';
	}
	const checkpoint = () => opened?.checkpoint();
</script>

<svelte:window
	onfocus={checkpoint}
	ononline={checkpoint}
	onpagehide={checkpoint}
	onbeforeunload={beforeUnload}
/>
<svelte:document onvisibilitychange={checkpoint} />

{#snippet refused(refusal: OpenRefusal)}
	<Empty.Root class={className}>
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Header>
			<Empty.Title>Could not open storage</Empty.Title>
			<Empty.Description role="alert">{refusal.description}</Empty.Description>
		</Empty.Header>
		{#if refusal.retry}
			<Empty.Content>
				<Button variant="outline" size="sm" onclick={() => { opening = openAndWrap(); }}>Try again</Button>
			</Empty.Content>
		{/if}
	</Empty.Root>
{/snippet}

{#await opening}
	<Loading class={className} label="Opening…" />
{:then result}
	{#if result.error}
		{@render refused(
			describeOpenRefusal(result.error),
		)}
	{:else}
		{@render children(result.data)}
	{/if}
{:catch error}
	{@render refused({ description: extractErrorMessage(error), retry: true })}
{/await}
