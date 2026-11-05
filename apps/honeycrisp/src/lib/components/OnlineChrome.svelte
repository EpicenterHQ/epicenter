<!--
	`#platform/chrome` in the web build: the header's account of its store,
	the person's repository, online only, whether it answers, and the
	account.
-->
<script lang="ts">
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import { toast } from '@epicenter/ui/sonner';
	import { account } from '../app.js';

	let {
		unavailable,
	}: {
		/** Why the store cannot be reached now (`folder.unavailable()`), if it cannot. */
		unavailable: { message: string } | null;
	} = $props();

	// The web build always has an account: its folder is the account's copy.
	const auth = account!;
	const state = $derived(auth.state());

	const status = $derived.by((): StatusLine => {
		if (state.status === 'reauth-required')
			return {
				label: 'Sign in again',
				detail: 'Sign in again to edit your repository.',
				tone: 'warning',
			};
		if (unavailable !== null) return { label: 'Offline', detail: unavailable.message, tone: 'warning' };
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
	{#if state.status !== 'signed-out'}
		{#if state.status === 'reauth-required'}
			<Button size="sm" onclick={() => void signIn()}>Sign in again</Button>
		{/if}
		<Button variant="ghost" size="sm" onclick={() => void signOut()}>Sign out</Button>
	{/if}
</div>
