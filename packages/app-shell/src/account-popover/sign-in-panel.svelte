<script lang="ts">
	import type { ReactiveAuthClient } from '@epicenter/auth/svelte';
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import Cloud from '@lucide/svelte/icons/cloud';

	/**
	 * The signed-out panel inside the account popover, the app's only auth
	 * surface (ADR-0088).
	 *
	 * Renders the one auth action for the selected server. The parent supplies
	 * whether that server uses the self-host setting; connection status comes
	 * from the auth client. All wording lives here; the parent passes only what
	 * varies per app.
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
	let signInError = $state<string | null>(null);
	const accountLocked = $derived(!!disabledReason);

	// Busy while the boot check is still connecting or a manual retry is in
	// flight. A pending boot check has no ceiling here: `fetch` has no default
	// timeout, so a box that accepts the socket but never answers leaves this on
	// "Connecting…" until the browser's own timeout fires. Refused connections
	// and 401s fail fast, so the common failures self-heal into a retryable state.
	const busy = $derived(
		signingIn || auth.connection.status === 'connecting',
	);

	// One sign-in surface: the primary button and the retry action both call
	// `auth.startSignIn()`. The client owns the hosted browser or native handoff;
	// this surface only chooses the human label.
	//
	// Pending until the page or the process is replaced, and cleared only on a
	// failure. See `sign-in-screen.svelte` for why: resolving means the launcher
	// finished its work, not that a navigation happened.
	async function startSignIn() {
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
	<Button class="w-full" disabled={busy || accountLocked} onclick={startSignIn}>
		{#if busy}
			<Spinner class="size-4" />
			Signing in…
		{:else if auth.state.status === 'reauth-required'}
			Reconnect
		{:else}
			<Cloud class="size-4" />
			Sign in with Epicenter
		{/if}
	</Button>
</div>
