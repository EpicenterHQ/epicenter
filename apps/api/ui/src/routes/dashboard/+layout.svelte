<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { Spinner } from '@epicenter/ui/spinner';
	import DashboardSession from '$lib/dashboard/DashboardSession.svelte';
	import { page } from '$app/state';
	import { readDashboardTarget } from '$lib/dashboard/navigation';
	import { auth, startDashboardSignIn } from '$lib/platform/auth';

	let { children } = $props();
	const target = $derived(readDashboardTarget(page.url));
	const mismatched = $derived(target.valid && target.expectedPrincipal !== null &&
		auth.state.status !== 'signed-out' && target.expectedPrincipal !== auth.state.account.principalId);

	let signingIn = $state(false);
	let signInError = $state<string | null>(null);
	async function startSignIn() {
		signingIn = true;
		signInError = null;
		try {
			const result = await startDashboardSignIn(mismatched ? { reauthenticate: true } : undefined);
			if (result.error) signInError = result.error.message;
		} finally {
			signingIn = false;
		}
	}
</script>

<svelte:head><title>Account: Epicenter</title><meta name="referrer" content="no-referrer" /></svelte:head>

{#if !target.valid}
	<div class="mx-auto max-w-sm px-6 py-16 space-y-4">
		<h1 class="text-xl font-semibold">This account link is invalid</h1>
		<p>Return to your app and open account management again.</p>
	</div>
{:else if auth.state.status !== 'signed-out' && !mismatched}
	{#key auth.state.account}
		<DashboardSession account={auth.state.account}>
			{@render children()}
		</DashboardSession>
	{/key}
{:else}
	<div class="flex min-h-screen items-center justify-center">
		<Card.Root class="w-full max-w-sm p-6">
			<div class="space-y-4 text-center">
				<div class="space-y-1">
					<p class="text-sm font-medium">{mismatched ? 'This link is for a different account' : 'Sign in to Epicenter'}</p>
					<p class="text-xs text-muted-foreground">
						{mismatched ? 'Sign in with the account you use in your app to continue. Nothing has been purchased.' : 'Sign in to view billing and usage.'}
					</p>
				</div>
				{#if signInError}
					<p class="text-xs text-destructive">{signInError}</p>
				{/if}
				<Button
					class="w-full"
					onclick={startSignIn}
					disabled={signingIn}
				>
					{#if signingIn}
						<Spinner class="size-4" />
						Signing in…
					{:else}
						Sign in with Epicenter
					{/if}
				</Button>
			</div>
		</Card.Root>
	</div>
{/if}
