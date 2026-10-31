<!--
	Capture over the captures it is given: a header with where they are, the
	connection, and the account, then the timeline or the one open capture.
	Every component under it reads and writes only through that list, so the
	root that passes it alone decides the store.
-->
<script lang="ts">
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { webAuth } from '$lib/auth.js';
	import { type CaptureList, createCaptures } from '$lib/captures.svelte.js';
	import CaptureDetail from './CaptureDetail.svelte';
	import TextDetail from './TextDetail.svelte';
	import Timeline from './Timeline.svelte';

	let {
		list,
	}: {
		/** The person's repository's captures, which every component under it reads and edits. */
		list: CaptureList;
	} = $props();

	// A page shows one store's captures for its life.
	// svelte-ignore state_referenced_locally
	const captures = createCaptures(list);
	const auth = webAuth();

	/** One page: the timeline or the one open capture. */
	const item = $derived(captures.opened);
	const status = $derived.by((): StatusLine => {
		if (auth.state.status === 'reauth-required')
			return {
				label: 'Sign in again',
				detail: 'Sign in again to edit your repository.',
				tone: 'warning',
			};
		if (list.error !== null) return { label: 'Offline', detail: list.error.message, tone: 'warning' };
		return { label: 'Online', tone: 'good' };
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
		<Button variant="ghost" size="sm" class="-ml-2.5" onclick={() => captures.leave()}>Capture</Button>
		<StatusPopover summary={status} details={[{ name: 'Status', testid: 'status-files', line: status }]}>
			<StatusRow name="Where">
				<span class="font-medium" data-testid="status-where">Your repository</span>
				<span class="mt-0.5 block text-xs text-muted-foreground">
					Your Epicenter repository, capture. Online only: nothing is kept in this browser.
				</span>
			</StatusRow>
		</StatusPopover>
		<div class="ml-auto flex items-center gap-2">
			{#if auth.state.status !== 'signed-out'}
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
