<!--
	One of Capture's two views (decision 76): a header with the two views,
	what the open one shows, and the account, then the timeline or the one
	open capture, over one client's captures: this browser's ("On this
	device") or the person's `capture` repository's ("Synced").
-->
<script lang="ts">
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { resolve } from '$app/paths';
	import { webAuth } from '$lib/auth.js';
	import { type CaptureList, createCaptures, type View } from '$lib/captures.svelte.js';
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
			return { label: 'On this device', tone: 'neutral' };
		}
		if (auth.state.status === 'reauth-required')
			return {
				label: 'Sign in again',
				detail: 'Sign in again to upload and to edit your repository.',
				tone: 'warning',
			};
		if (list.error !== null) return { label: 'Offline', detail: list.error.message, tone: 'warning' };
		return { label: 'Synced', tone: 'good' };
	});

	async function signIn() {
		const { error } = await auth.startSignIn();
		if (error !== null) toast.error('Could not sign in', { description: error.message });
	}

	async function signOut() {
		const { error } = await auth.signOut();
		if (error !== null) toast.error('Could not sign out', { description: error.message });
	}
</script>

<header class="border-b">
	<div class="mx-auto flex h-12 max-w-3xl items-center gap-2 px-4 sm:px-6">
		<!-- On narrow screens the views say what this is; the width goes to them and status. -->
		<Button variant="ghost" size="sm" class="-ml-2.5 max-sm:hidden" onclick={() => captures.leave()}>Capture</Button>
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
		<StatusPopover summary={status} details={[{ name: 'Status', testid: 'status-files', line: status }]}>
			<StatusRow name="Where">
				<span class="font-medium" data-testid="status-where">{view === 'synced' ? 'Your repository' : 'This browser'}</span>
				<span class="mt-0.5 block text-xs text-muted-foreground">
					{#if view === 'synced'}
						Your Epicenter repository, capture.
					{:else if auth.state.status !== 'signed-out'}
						Kept in this browser until they upload to your repository on their own; then they are under Synced.
					{:else}
						Kept in this browser. Sign in and they upload to your Epicenter repository, under Synced.
					{/if}
				</span>
			</StatusRow>
		</StatusPopover>
		<div class="ml-auto flex items-center gap-2">
			{#if auth.state.status === 'signed-out'}
				<Button size="sm" onclick={() => void signIn()}>Sign in</Button>
			{:else}
				{#if auth.state.status === 'reauth-required'}
					<Button size="sm" onclick={() => void signIn()}>Sign in again</Button>
				{/if}
				<Button variant="ghost" size="sm" onclick={() => void signOut()}>Sign out</Button>
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
