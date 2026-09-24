<script lang="ts">
	import { isCallbackAuthClient, type AuthClient } from '@epicenter/auth';
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { confirmAccountChange } from './confirm-account-change.js';

	/**
	 * Sign-in document without an open App.
	 */
	type SignInScreenProps = {
		/**
		 * The client for this build’s configured server.
		 *
		 * This document owns no App, and successful sign-in
		 * replaces this document or process.
		 */
		auth: AuthClient;
		/** The application's name, as the heading, e.g. `'Honeycrisp'`. */
		appName: string;
		/** What this application calls a person's stuff, plural, e.g. `'notes'`. */
		noun: string;
		onCancel?: () => void;
	};

	let { auth, appName, noun, onCancel }: SignInScreenProps = $props();

	// A successful request starts document navigation or native restart. Keep
	// the button disabled until that replacement actually happens.
	let signingIn = $state(false);
	let signInError = $state<string | undefined>(undefined);
	async function signIn() {
		if (signingIn) return;
		signInError = undefined;
		signingIn = true;
		if (!isCallbackAuthClient(auth) && !(await confirmAccountChange(auth))) {
			signingIn = false;
			return;
		}
		const { error } = await auth.startSignIn();
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
			<p class="text-sm text-muted-foreground">{`Sign in to open your ${noun}.`}</p>
			{#if signInError !== undefined}
				<p class="text-xs text-destructive">{signInError}</p>
			{/if}
		</div>
		<Button size="lg" disabled={signingIn} onclick={signIn}>
			{#if signingIn}
				<Spinner class="size-4" />
				Signing in…
			{:else}
				Sign in
			{/if}
		</Button>
		{#if onCancel}<Button variant="ghost" disabled={signingIn} onclick={onCancel}>Back to {appName}</Button>{/if}
	</div>
</div>
