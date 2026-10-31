<!--
	The header: the app's name, the two ways to use Honeycrisp, "On this
	browser" (`/`) and "Online" (`/online`), what the open one is, and,
	online, the account. They are two separate sets of notes in two stores;
	nothing moves from one to the other, so each link loads a new page.
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
	import { getHoneycrisp, type Variant } from '$lib/honeycrisp.svelte.js';

	const { notes, folders } = getHoneycrisp();
	let { variant }: { variant: Variant } = $props();
	// Honeycrisp has no hosted capabilities: only the online variant signs in.
	// svelte-ignore state_referenced_locally
	const auth = variant === 'online' ? webAuth() : null;

	const status = $derived.by((): StatusLine => {
		const unreadable = notes.error ?? folders.error;
		if (variant === 'local') {
			if (unreadable !== null)
				return { label: 'Not readable here', detail: unreadable.message, tone: 'error' };
			return { label: 'On this browser', tone: 'neutral' };
		}
		if (auth?.state.status === 'reauth-required')
			return {
				label: 'Sign in again',
				detail: 'Sign in again to edit your repository.',
				tone: 'warning',
			};
		if (unreadable !== null) return { label: 'Offline', detail: unreadable.message, tone: 'warning' };
		return { label: 'Online', tone: 'good' };
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
</script>

<header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
	<h1 class="text-sm font-semibold max-sm:sr-only">Honeycrisp</h1>
	<nav class="flex items-center gap-1" aria-label="Ways to use Honeycrisp">
		<Button
			size="sm"
			variant={variant === 'local' ? 'secondary' : 'ghost'}
			href={resolve('/')}
			data-sveltekit-reload
			aria-current={variant === 'local' ? 'page' : undefined}
		>
			On this browser
		</Button>
		<Button
			size="sm"
			variant={variant === 'online' ? 'secondary' : 'ghost'}
			href={resolve('/online')}
			data-sveltekit-reload
			aria-current={variant === 'online' ? 'page' : undefined}
		>
			Online
		</Button>
	</nav>
	<StatusPopover summary={status} details={[{ name: 'Status', testid: 'status-files', line: status }]}>
		<StatusRow name="Where">
			<span class="font-medium" data-testid="status-where">{variant === 'local' ? 'This browser' : 'Your repository'}</span>
			<span class="mt-0.5 block text-xs text-muted-foreground">
				{#if variant === 'online'}
					Your Epicenter repository, honeycrisp. Online only: nothing is kept in this browser.
				{:else}
					Kept in this browser only, with no account. They never leave it; Online is a separate set of notes.
				{/if}
			</span>
		</StatusRow>
	</StatusPopover>
	<div class="ml-auto flex min-w-0 items-center gap-1">
		<LightSwitch variant="ghost" />
		{#if auth !== null && auth.state.status !== 'signed-out'}
			{#if auth.state.status === 'reauth-required'}
				<Button size="sm" onclick={() => void signIn()}>Sign in again</Button>
			{/if}
			<Button variant="ghost" size="sm" onclick={() => void signOut()}>Sign out</Button>
		{/if}
	</div>
</header>
