<script lang="ts">
	import type { AuthClient, AuthStartup } from '@epicenter/auth';
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import ServerConnection from './server-connection.svelte';

	/**
	 * Connection choices shown after the boot owner has closed its app session.
	 */
	type SignInScreenProps = {
		/**
		 * The startup selection and the connection actions it supports.
		 *
		 * The boot owner has already closed the app, and successful sign-in
		 * replaces this document or process.
		 */
		startup: AuthStartup;
		/** The application's name, as the heading, e.g. `'Honeycrisp'`. */
		appName: string;
		/** What this application calls a person's stuff, plural, e.g. `'notes'`. */
		noun: string;
		onCancel?: () => void;
	};

	let { startup, appName, noun, onCancel }: SignInScreenProps = $props();

	/**
	 * Pending until the page or the process is replaced, which is why there is no
	 * `finally` below.
	 *
	 * Resolving means the launcher finished its work, not that a navigation
	 * happened (`auth-contract.ts`). The desktop broker answers 202 as soon as
	 * the host has started sign-in out of process, in loopback milliseconds, and
	 * then nothing on this page moves again until the process is replaced; the
	 * hosted client assigns `location.href` and returns without blocking.
	 * Clearing the flag on success re-enables the button in the gap and invites
	 * the second click this state exists to prevent.
	 */
	let signingIn = $state(false);
	let connecting = $state(false);
	let signInError = $state<string | undefined>(undefined);
	let selection: ReturnType<NonNullable<AuthClient['startSignIn']>> | undefined;
	function select(action: () => ReturnType<NonNullable<AuthClient['startSignIn']>>) {
		if (selection) return selection;
		selection = action().then((result) => {
			if (result.error) selection = undefined;
			return result;
		});
		return selection;
	}

	async function signIn() {
		const start = startup.auth?.startSignIn;
		if (!start) return;
		signInError = undefined;
		signingIn = true;
		const { error } = await select(() => start());
		if (error !== null) {
			signInError = error.message;
			signingIn = false;
		}
	}
</script>

<div class="flex h-dvh items-center justify-center p-6 text-center">
	<div class="flex max-w-sm flex-col items-center gap-4">
		<div class="space-y-2">
			<h1 class="text-lg font-semibold">{appName}</h1>
			{#if startup.auth === null}
				<p role="alert" class="text-sm">Your saved server choice could not be read. Choose a server to continue. Your local data is still on this device.</p>
			{/if}
			<p class="text-sm text-muted-foreground">{onCancel ? 'Choose where to connect.' : `Sign in to open your ${noun}.`}</p>
			{#if signInError !== undefined}
				<p class="text-xs text-destructive">{signInError}</p>
			{/if}
		</div>
		{#if startup.signInLocation === 'host-settings'}
			<p class="text-sm text-muted-foreground">Open Home Settings to sign in to your server.</p>
		{:else if startup.auth?.startSignIn}
			<Button size="lg" disabled={signingIn || connecting} onclick={signIn}>
				{#if signingIn}
					<Spinner class="size-4" />
					Signing in…
				{:else}
					{startup.selectedServer ? 'Sign in to your server' : 'Sign in with Epicenter'}
				{/if}
			</Button>
		{/if}
		<ServerConnection {startup} {select} disabled={signingIn} bind:pending={connecting} />
		{#if onCancel}<Button variant="ghost" disabled={signingIn || connecting} onclick={onCancel}>Back to {appName}</Button>{/if}
	</div>
</div>
