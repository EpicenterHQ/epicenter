<script lang="ts">
	import type { ReactiveAuthClient } from '@epicenter/auth/svelte';
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import Cloud from '@lucide/svelte/icons/cloud';
	import { confirmAccountChange } from '../boot-screens/confirm-account-change.js';
	import { getConnectionScreen } from '../boot-screens/connection-screen-context.js';

	type SignInPanelProps = {
		/** The app's auth client; its `startSignIn` drives the primary button. */
		auth: ReactiveAuthClient;
		/** Noun describing what gets synced, e.g. "tabs" or "notes". */
		syncNoun: string;
	};

	let { auth, syncNoun }: SignInPanelProps = $props();

	let signingIn = $state(false);
	const openConnection = getConnectionScreen();
	let signInError = $state<string | null>(null);

	// Pending until the page or the process is replaced, and cleared only on a
	// failure. See `sign-in-screen.svelte` for why: resolving means the launcher
	// finished its work, not that a navigation happened.
	async function startSignIn() {
		if (signingIn) return;
		signingIn = true;
		if (!(await confirmAccountChange(auth))) {
			signingIn = false;
			return;
		}
		signInError = null;
		const { error } = await auth.startSignIn();
		if (error) {
			signInError = error.message;
			signingIn = false;
		}
	}
</script>

<div class="flex flex-col gap-3">
	<div class="space-y-1">
		<p class="text-sm font-medium">Sync across devices</p>
		<p class="text-xs leading-relaxed text-muted-foreground">
			Your {syncNoun} live on this device. Sign in to sync them to your other
			devices.
		</p>
	</div>
	{#if signInError}
		<p class="text-xs text-destructive">{signInError}</p>
	{/if}
	{#if openConnection}
		<Button class="w-full" onclick={openConnection}>Connect</Button>
	{:else}
		<Button class="w-full" disabled={signingIn} onclick={startSignIn}>
			{#if signingIn}
				<Spinner class="size-4" />
				Signing in…
			{:else if auth.state.status === 'reauth-required'}
				Reconnect
			{:else}
				<Cloud class="size-4" />
				Sign in
			{/if}
		</Button>
	{/if}
</div>
