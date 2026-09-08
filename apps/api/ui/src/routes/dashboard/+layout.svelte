<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { Spinner } from '@epicenter/ui/spinner';
	import DashboardSession from '$lib/dashboard/DashboardSession.svelte';
	import { auth } from '$lib/platform/auth';

	let { children } = $props();

	let signingIn = $state(false);
	let signInError = $state<string | null>(null);
	async function startSignIn() {
		signingIn = true;
		signInError = null;
		try {
			const result = await auth.startSignIn();
			if (result.error) signInError = result.error.message;
		} finally {
			signingIn = false;
		}
	}
</script>

<svelte:head><title>Billing: Epicenter</title></svelte:head>

{#if auth.state.status !== 'signed-out'}
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
					<p class="text-sm font-medium">Sign in to Epicenter</p>
					<p class="text-xs text-muted-foreground">
						Sign in to view billing and usage.
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
