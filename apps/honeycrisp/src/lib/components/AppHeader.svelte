<!--
	The header: the app's name, the two views (decision 76), "On this device"
	and "Synced", what the open one shows, and the account.
-->
<script lang="ts">
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import { toast } from '@epicenter/ui/sonner';
	import { resolve } from '$app/paths';
	import { webAuth } from '$lib/auth.js';
	import { getHoneycrisp, type View } from '$lib/honeycrisp.svelte.js';

	const { notes, folders } = getHoneycrisp();
	const auth = webAuth();
	let { view }: { view: View } = $props();

	const signedIn = $derived(auth.state.status !== 'signed-out');
	const status = $derived.by((): StatusLine => {
		const unreadable = notes.error ?? folders.error;
		if (view === 'device') {
			if (unreadable !== null)
				return { label: 'Not readable here', detail: unreadable.message, tone: 'error' };
			return { label: 'On this device', tone: 'neutral' };
		}
		if (auth.state.status === 'reauth-required')
			return {
				label: 'Sign in again',
				detail: 'Sign in again to upload and to edit your repository.',
				tone: 'warning',
			};
		if (unreadable !== null) return { label: 'Offline', detail: unreadable.message, tone: 'warning' };
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

<header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
	<h1 class="text-sm font-semibold max-sm:sr-only">Honeycrisp</h1>
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
			<span class="font-medium" data-testid="status-where">{view === 'device' ? 'This browser' : 'Your repository'}</span>
			<span class="mt-0.5 block text-xs text-muted-foreground">
				{#if view === 'synced'}
					Your Epicenter repository, honeycrisp.
				{:else if signedIn}
					Kept in this browser until they upload to your repository on their own; then they are under Synced.
				{:else}
					Kept in this browser. Sign in and they upload to your Epicenter repository, under Synced.
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
