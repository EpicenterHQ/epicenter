<!--
	Capture: a header that says where the captures are and who is signed in,
	then the timeline or the one open capture. Signed out, the captures are
	this browser's; signed in (under the signed-in boundary), this browser's
	and the person's `capture` repository's as one list, and the ones made
	here count as "not uploaded yet" until they are up.
-->
<script lang="ts">
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { type Capture, capture } from '@epicenter/capture';
	import { fromClient, oneList } from '@epicenter/svelte/client';
	import { getRepo } from '@epicenter/svelte/repo';
	import { webAuth } from '$lib/auth.js';
	import { type CaptureList, createCaptures } from '$lib/captures.svelte.js';
	import { device } from '$lib/device.js';
	import CaptureDetail from './CaptureDetail.svelte';
	import TextDetail from './TextDetail.svelte';
	import Timeline from './Timeline.svelte';

	/** Whether this renders under the signed-in boundary, which has the repository. */
	let { signedIn }: { signedIn: boolean } = $props();

	// The list and the account stay fixed until this app root unmounts.
	// svelte-ignore state_referenced_locally
	const list: CaptureList = signedIn
		? oneList(fromClient(device).captures, fromClient(getRepo<Capture>()).captures, {
				createOn: 'device',
			})
		: fromClient(device).captures;
	// svelte-ignore state_referenced_locally
	const captures = createCaptures(list, { uploads: signedIn });
	const auth = webAuth();

	/** One page: the timeline or the one open capture. */
	const item = $derived(captures.opened);
	/** Signed in, the captures made here that have not reached the repository yet. */
	const waiting = $derived(list.items.filter(({ id }) => list.where?.({ id }) === 'device').length);
	const status = $derived.by((): StatusLine => {
		if (list.error !== null)
			return { label: 'Not readable here', detail: list.error.message, tone: 'error' };
		if (!signedIn) return { label: 'On this device', tone: 'neutral' };
		if (auth.state.status === 'reauth-required')
			return {
				label: 'Uploads paused',
				detail: 'Sign in again to upload and to edit your repository.',
				tone: 'warning',
			};
		// New captures still save, to this browser, and upload once it is back.
		if (list.repositoryError)
			return {
				label: 'Offline: new captures wait to upload',
				short: 'Offline',
				detail: list.repositoryError.message,
				tone: 'warning',
			};
		if (waiting > 0) return { label: `${waiting} not uploaded yet`, tone: 'busy' };
		return { label: 'In your repository', tone: 'good' };
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
				<span class="font-medium" data-testid="status-where">{signedIn ? 'Your repository' : 'This browser'}</span>
				<span class="mt-0.5 block text-xs text-muted-foreground">
					{#if signedIn}
						Your Epicenter repository, capture. Captures made here go to this browser first and upload on their own.
					{:else}
						Kept in this browser. Sign in to keep them in your Epicenter repository; these upload then.
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
