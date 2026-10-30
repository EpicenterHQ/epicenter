<!--
	Open one folder, refresh it on return, and close it when unmounted; edits
	inside have already queued their latest input. Leaving the page is unsure
	while a write is out: a browser asks "Leave site?", and a desktop window
	waits for the writes, then asks only if the page is still unsure.
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
	import { type SvelteFolder, svelteFolder } from './folder.js';
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

	async function openAndWrap() {
		const result = await open();
		if (result.error !== null) return result;
		const folder = result.data;
		if (destroyed) {
			void folder.close();
			return Ok(svelteFolder(folder));
		}
		opened = folder;
		// A folder opened beneath another leaves the window's close to the outer one.
		if (holdWindowClose) {
			let stop: () => void;
			try {
				stop = await registerWindowClose(() => folder.idle());
			} catch (cause) {
				opened = undefined;
				await folder.close();
				throw new Error('Could not protect changes when closing this window', { cause });
			}
			if (destroyed) stop();
			else stopWindow = stop;
		}
		return Ok(svelteFolder(folder));
	}
	let opening = $state(openAndWrap());

	onDestroy(() => {
		destroyed = true;
		stopWindow?.();
		if (opened !== undefined) void opened.close();
		void opening.catch(() => {});
	});

	/** Leaving is unsure while a write is out. */
	function beforeUnload(event: Event) {
		if (opened?.saving()) event.preventDefault();
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
