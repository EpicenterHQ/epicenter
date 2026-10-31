<!--
	One of Capture's two views (decision 76): a header with the two views,
	what the open one shows, and the account, then the timeline or the one
	open capture, over one client's captures: this browser's ("On this
	device") or the person's `capture` repository's ("Synced").

	The desktop window (`#platform/*` under `tauri`) has one view, its
	folder, and no account: its header says whether Epicenter syncs the
	folder, offers Sync with Epicenter until it does, and Choose folder…
	(decision 81).
-->
<script lang="ts">
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { whenSaved } from '@epicenter/svelte/leave-guard';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { webAuth } from '#platform/auth';
	import { folder } from '#platform/folder';
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { type CaptureList, createCaptures, type View } from '$lib/captures.svelte.js';
	import type { FolderRequest, FolderSync } from '$lib/platform.js';
	import CaptureDetail from './CaptureDetail.svelte';
	import TextDetail from './TextDetail.svelte';
	import Timeline from './Timeline.svelte';

	let {
		view,
		list,
	}: {
		/** Which view this is: this browser's captures, or the repository's. */
		view: View;
		/** That view's client's captures, which every component under it reads and edits. */
		list: CaptureList;
	} = $props();

	// A page shows one client's captures for its life.
	// svelte-ignore state_referenced_locally
	const captures = createCaptures(list, { view });
	const auth = webAuth();

	/** One page: the timeline or the one open capture. */
	const item = $derived(captures.opened);
	const status = $derived.by((): StatusLine => {
		if (view === 'device') {
			if (list.error !== null)
				return { label: 'Not readable here', detail: list.error.message, tone: 'error' };
			if (sync === 'synced') return { label: 'Synced by Epicenter', tone: 'good' };
			return { label: 'On this device', tone: 'neutral' };
		}
		if (auth?.state.status === 'reauth-required')
			return {
				label: 'Sign in again',
				detail: 'Sign in again to upload and to edit your repository.',
				tone: 'warning',
			};
		if (list.error !== null) return { label: 'Offline', detail: list.error.message, tone: 'warning' };
		return { label: 'Synced', tone: 'good' };
	});

	async function signIn() {
		if (auth === null) return;
		const { error } = await auth.startSignIn();
		if (error !== null) toast.error('Could not sign in', { description: error.message });
	}

	async function signOut() {
		if (auth === null) return;
		const { error } = await auth.signOut();
		if (error !== null) toast.error('Could not sign out', { description: error.message });
	}

	// The desktop window's folder: whether Epicenter syncs it, asked again
	// whenever the window comes back, since Epicenter sets it up meanwhile.
	let sync = $state<FolderSync>('unknown');
	let request = $state<{ tone: 'requested' | 'failed'; message: string }>();
	let asking = $state(false);

	async function checkSync() {
		if (folder !== null) sync = await folder.synced();
	}
	onMount(() => void checkSync());

	async function ask(action: () => Promise<FolderRequest>, requested?: string) {
		asking = true;
		request = undefined;
		const answer = await action();
		asking = false;
		if (!answer.ok) request = { tone: 'failed', message: answer.message };
		else if (requested !== undefined) request = { tone: 'requested', message: requested };
	}

	function syncWithEpicenter() {
		const desktop = folder;
		if (desktop === null) return;
		void ask(
			() => desktop.syncWithEpicenter(),
			'Asked your computer to open Epicenter. If it is installed, choose where to sync there.',
		);
	}

	// Moving replaces this window; its saves land first.
	function chooseFolder() {
		const desktop = folder;
		if (desktop === null) return;
		void ask(async () => {
			await whenSaved();
			return desktop.chooseFolder();
		});
	}
</script>

<svelte:window onfocus={() => void checkSync()} />

<header class="border-b">
	<div class="mx-auto flex h-12 max-w-3xl items-center gap-2 px-4 sm:px-6">
		<!-- On narrow screens the views say what this is; the width goes to them and status. -->
		<Button variant="ghost" size="sm" class="-ml-2.5 max-sm:hidden" onclick={() => captures.leave()}>Capture</Button>
		{#if auth !== null}
		<nav class="flex items-center gap-1" aria-label="Views">
			<Button
				size="sm"
				variant={view === 'device' ? 'secondary' : 'ghost'}
				href={resolve('/')}
				aria-current={view === 'device' ? 'page' : undefined}
			>
				On this device
			</Button>
			<Button
				size="sm"
				variant={view === 'synced' ? 'secondary' : 'ghost'}
				href={resolve('/synced')}
				aria-current={view === 'synced' ? 'page' : undefined}
			>
				Synced
			</Button>
		</nav>
		{/if}
		<StatusPopover summary={status} details={[{ name: 'Status', testid: 'status-files', line: status }]}>
			<StatusRow name="Where">
				<span class="font-medium" data-testid="status-where">
					{folder !== null ? 'This computer' : view === 'synced' ? 'Your repository' : 'This browser'}
				</span>
				<span class="mt-0.5 block text-xs text-muted-foreground">
					{#if folder !== null}
						{#if sync === 'synced'}
							Capture's folder on this computer. Epicenter syncs it to your repository.
						{:else}
							Capture's folder on this computer. Sync with Epicenter to keep it in your repository too.
						{/if}
					{:else if view === 'synced'}
						Your Epicenter repository, capture.
					{:else if auth !== null && auth.state.status !== 'signed-out'}
						Kept in this browser until they upload to your repository on their own; then they are under Synced.
					{:else}
						Kept in this browser. Sign in and they upload to your Epicenter repository, under Synced.
					{/if}
				</span>
			</StatusRow>
			{#snippet footer()}
				{#if folder !== null}
					<Button variant="outline" size="sm" disabled={asking} onclick={chooseFolder}>Choose folder…</Button>
				{/if}
			{/snippet}
		</StatusPopover>
		<div class="ml-auto flex min-w-0 items-center gap-2">
			{#if request !== undefined}
				<p
					role="status"
					class={['min-w-0 truncate text-xs', request.tone === 'failed' ? 'text-destructive' : 'text-muted-foreground']}
					title={request.message}
				>
					{request.message}
				</p>
			{/if}
			{#if folder !== null && sync !== 'synced'}
				<Button variant="outline" size="sm" disabled={asking} onclick={syncWithEpicenter}>Sync with Epicenter</Button>
			{/if}
			<!-- The desktop window signs in to nothing. -->
			{#if auth !== null}
				{#if auth.state.status === 'signed-out'}
					<Button size="sm" onclick={() => void signIn()}>Sign in</Button>
				{:else}
					{#if auth.state.status === 'reauth-required'}
						<Button size="sm" onclick={() => void signIn()}>Sign in again</Button>
					{/if}
					<Button variant="ghost" size="sm" onclick={() => void signOut()}>Sign out</Button>
				{/if}
			{/if}
		</div>
	</div>
</header>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-16 pt-6 sm:px-6">
	<div>
		{#if item === undefined}
			<Timeline {captures} />
		{:else if item.mode === 'capture'}
			{#key item}
				<CaptureDetail {captures} id={item.id} />
			{/key}
		{:else}
			{#key item}
				<TextDetail {captures} id={item.id} />
			{/key}
		{/if}
	</div>
</main>
