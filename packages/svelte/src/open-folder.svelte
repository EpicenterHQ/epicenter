<!--
	Open one folder, refresh it on return, and close after mounted drafts have
	flushed their latest input. Desktop close waits for the queued writes.
-->
<script lang="ts" generics="TTables extends Record<string, TSchema>">
	import type { Folder, Opened } from '@epicenter/folder';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { onDestroy, type Snippet } from 'svelte';
	import type { TSchema } from 'typebox';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { Ok } from 'wellcrafted/result';
	import { type SvelteFolder, svelteFolder } from './folder-next.js';
	import { describeOpenRefusal, type OpenRefusal } from './open-refusal.js';
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

	let opened: Folder<TTables> | undefined;
	let stopWindow: (() => void) | undefined;
	let destroyed = false;

	const saving = () => opened?.saving() ?? false;

	function closeFolder(folder: Folder<TTables>) {
		window.dispatchEvent(new CustomEvent('epicenter:folder-close'));
		return folder.close();
	}

	async function openAndWrap() {
		const result = await open();
		if (result.error !== null) return result;
		const folder = result.data;
		if (destroyed) {
			void closeFolder(folder);
			return Ok(svelteFolder(folder));
		}
		opened = folder;
		// One guard per window: a folder opened beneath another leaves the
		// window's close to the outer one. It never asks: it waits for the
		// writes in flight, which answer in milliseconds.
		if (holdWindowClose) {
			const stop = await registerWindowClose(
				() => false,
				() => {},
				() => closeFolder(folder),
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
		if (opened !== undefined) void closeFolder(opened);
		void opening.catch(() => {});
	});

	function beforeUnload(event: BeforeUnloadEvent) {
		window.dispatchEvent(new CustomEvent('epicenter:folder-close'));
		if (!saving()) return;
		event.preventDefault();
		event.returnValue = '';
	}
	const refresh = () => { void opened?.refresh(); };
	const visible = () => {
		if (document.visibilityState === 'visible') refresh();
	};
</script>

<svelte:window
	onfocus={refresh}
	ononline={refresh}
	onbeforeunload={beforeUnload}
/>
<svelte:document onvisibilitychange={visible} />

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
