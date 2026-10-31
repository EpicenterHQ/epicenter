<!--
	The header: the app's name, where the notes are, and the account. Signed
	out, they are this browser's; signed in, they are the person's
	`honeycrisp` repository, and the notes and folders made here signed out
	or offline count as "not uploaded yet" until they upload.
-->
<script lang="ts">
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import { toast } from '@epicenter/ui/sonner';
	import { webAuth } from '$lib/auth.js';
	import { getHoneycrisp } from '$lib/honeycrisp.svelte.js';

	const { notes, folders } = getHoneycrisp();
	const auth = webAuth();

	const signedIn = $derived(auth.state.status !== 'signed-out');
	/** Signed in, the notes and folders made here that have not reached the repository yet. */
	const waiting = $derived(
		notes.items.filter(({ id }) => notes.where?.({ id }) === 'device').length +
			folders.items.filter(({ id }) => folders.where?.({ id }) === 'device').length,
	);
	const status = $derived.by((): StatusLine => {
		const unreadable = notes.error ?? folders.error;
		if (unreadable !== null)
			return { label: 'Not readable here', detail: unreadable.message, tone: 'error' };
		if (!signedIn) return { label: 'On this device', tone: 'neutral' };
		if (auth.state.status === 'reauth-required')
			return {
				label: 'Uploads paused',
				detail: 'Sign in again to upload and to edit your repository.',
				tone: 'warning',
			};
		// New notes still save, to this device, and upload once it is back.
		const offline = notes.repositoryError || folders.repositoryError;
		if (offline)
			return {
				label: 'Offline: new notes wait to upload',
				short: 'Offline',
				detail: offline.message,
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

<header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
	<h1 class="text-sm font-semibold max-sm:sr-only">Honeycrisp</h1>
	<StatusPopover summary={status} details={[{ name: 'Status', testid: 'status-files', line: status }]}>
		<StatusRow name="Where">
			<span class="font-medium" data-testid="status-where">{signedIn ? 'Your repository' : 'This browser'}</span>
			<span class="mt-0.5 block text-xs text-muted-foreground">
				{#if signedIn}
					Your Epicenter repository, honeycrisp. Notes made here while signed out or offline upload on their own.
				{:else}
					Kept in this browser. Sign in to keep them in your Epicenter repository; these upload then.
				{/if}
			</span>
		</StatusRow>
	</StatusPopover>
	<div class="ml-auto flex min-w-0 items-center gap-1">
		<LightSwitch variant="ghost" />
		{#if auth.state.status === 'signed-out'}
			<Button size="sm" onclick={() => void signIn()}>Sign in</Button>
		{:else}
			{#if auth.state.status === 'reauth-required'}
				<Button size="sm" onclick={() => void signIn()}>Sign in again</Button>
			{/if}
			<Button variant="ghost" size="sm" onclick={() => void signOut()}>Sign out</Button>
		{/if}
	</div>
</header>
