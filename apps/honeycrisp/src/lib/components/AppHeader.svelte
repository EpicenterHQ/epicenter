<!--
	The header: the app's name, where the notes are and whether the
	repository answers, and the account.
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

	const status = $derived.by((): StatusLine => {
		if (auth.state.status === 'reauth-required')
			return {
				label: 'Sign in again',
				detail: 'Sign in again to edit your repository.',
				tone: 'warning',
			};
		const unreadable = notes.error ?? folders.error;
		if (unreadable !== null) return { label: 'Offline', detail: unreadable.message, tone: 'warning' };
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

<header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
	<h1 class="text-sm font-semibold">Honeycrisp</h1>
	<StatusPopover summary={status} details={[{ name: 'Status', testid: 'status-files', line: status }]}>
		<StatusRow name="Where">
			<span class="font-medium" data-testid="status-where">Your repository</span>
			<span class="mt-0.5 block text-xs text-muted-foreground">
				Your Epicenter repository, honeycrisp. Online only: nothing is kept in this browser.
			</span>
		</StatusRow>
	</StatusPopover>
	<div class="ml-auto flex min-w-0 items-center gap-1">
		<LightSwitch variant="ghost" />
		{#if auth.state.status !== 'signed-out'}
			{#if auth.state.status === 'reauth-required'}
				<Button size="sm" onclick={() => void signIn()}>Sign in again</Button>
			{/if}
			<Button variant="ghost" size="sm" onclick={() => void signOut()}>Sign out</Button>
		{/if}
	</div>
</header>
