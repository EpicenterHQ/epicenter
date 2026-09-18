<script lang="ts">
	import type { ReactiveAuthClient } from '@epicenter/auth/svelte';
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import Cloud from '@lucide/svelte/icons/cloud';
	import { getConnectionScreen } from '../boot-screens/connection-screen-context.js';

	/**
	 * Account navigation inside an app first asks its boot owner to close.
	 * Surfaces without an app session can start hosted sign-in directly.
	 */
	type SignInPanelProps = {
		/** The app's auth client; its `startSignIn` drives the primary button. */
		auth: ReactiveAuthClient;
		/** Noun describing what gets synced, e.g. "tabs" or "notes". */
		syncNoun: string;
		/**
		 * When set, the primary sign-in and the connect/change actions are
		 * disabled, and the reason is shown as a muted line. Lets a host block a
		 * page-reloading account change at an unsafe moment, e.g. Whispering during
		 * a recording. Omit to leave the actions enabled.
		 */
		disabledReason?: string;
	};

	let { auth, syncNoun, disabledReason }: SignInPanelProps = $props();

	let signingIn = $state(false);
	const openConnection = getConnectionScreen();
	let signInError = $state<string | null>(null);
	const accountLocked = $derived(!!disabledReason);

	// Pending until the page or the process is replaced, and cleared only on a
	// failure. See `sign-in-screen.svelte` for why: resolving means the launcher
	// finished its work, not that a navigation happened.
	async function startSignIn() {
		if (!auth.startSignIn) return;
		signInError = null;
		signingIn = true;
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
	{#if disabledReason}
		<p class="text-xs text-muted-foreground">{disabledReason}</p>
	{/if}
	{#if signInError}
		<p class="text-xs text-destructive">{signInError}</p>
	{/if}
	{#if openConnection}
		<Button class="w-full" disabled={accountLocked} onclick={openConnection}>Connect</Button>
	{:else if auth.startSignIn}
		<Button class="w-full" disabled={signingIn || accountLocked} onclick={startSignIn}>
			{#if signingIn}
				<Spinner class="size-4" />
				Signing in…
			{:else if auth.state.status === 'reauth-required'}
				Reconnect
			{:else}
				<Cloud class="size-4" />
				Sign in with Epicenter
			{/if}
		</Button>
	{/if}
</div>
