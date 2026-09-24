<script lang="ts">
	import { AuthError, isCallbackAuthClient } from '@epicenter/auth';
	import { Ok, tryAsync } from 'wellcrafted/result';
	import type { ReactiveAuthClient } from '@epicenter/auth/svelte';
	import type { Snippet } from 'svelte';
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import { toastOnError } from '@epicenter/ui/sonner';
	import CircleUser from '@lucide/svelte/icons/circle-user';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import LogOut from '@lucide/svelte/icons/log-out';
	import {
		createMutation,
		createQuery,
		QueryClient,
	} from '@tanstack/svelte-query';
	import { resultMutationOptions, resultQueryOptions } from 'wellcrafted/query';
	import { confirmAccountChange } from '../boot-screens/confirm-account-change.js';
	import SignInPanel from './sign-in-panel.svelte';
	import { getSignOut } from '../boot-screens/connection-screen-context.js';

	const accountProfileQueryClient = new QueryClient({
		defaultOptions: {
			queries: {
				refetchOnWindowFocus: false,
			},
		},
	});

	/**
	 * Shared account popover.
	 *
	 * Renders hosted auth identity, account website navigation, and sign-out.
	 *
	 * Mount once in each app's root layout, alongside `<ConfirmationDialog />`
	 * and inside a `<Tooltip.Provider>`: the trigger pill renders a tooltip,
	 * which a `Tooltip.Root` needs as an ancestor.
	 */
	type AccountPopoverProps = {
		/**
		 * The app's reactive auth client for its configured server.
		 */
		auth: ReactiveAuthClient;
		/** Noun describing what gets synced, e.g. "tabs" or "notes". */
		syncNoun: string;
		/** Optional replacement for the compact account icon trigger. */
		trigger?: Snippet<[{ props: Record<string, unknown> }]>;
	};

	let {
		auth,
		syncNoun,
		trigger,
	}: AccountPopoverProps = $props();

	let popoverOpen = $state(false);
	const signOutApplication = getSignOut();
	const isSignedIn = $derived(auth.state.status === 'signed-in');
	// A new auth selection gets its own profile query. The controller captures
	// its account when the request begins; retirement cancels a stale read.
	const profile = createQuery(
		() =>
			resultQueryOptions({
				queryKey: ['account-profile', auth.state],
				queryFn: () => auth.getProfile(),
				enabled: auth.state.status !== 'signed-out',
				staleTime: 0,
			}),
		() => accountProfileQueryClient,
	);
	const accountLabel = $derived(
		profile.data?.email ?? (profile.data ? 'Your server' : profile.error ? 'Offline' : 'Loading...'),
	);

	const signOut = createMutation(
		() =>
			resultMutationOptions({
				mutationKey: ['account', 'signOut'],
				mutationFn: async () => {
					if (signOutApplication) {
						return tryAsync({ try: signOutApplication, catch: (cause) => AuthError.SignOutFailed({ cause }) });
					}
					if (!(await confirmAccountChange(auth))) return Ok(undefined);
					const result = await auth.signOut();
					if (!result.error && isCallbackAuthClient(auth)) location.reload();
					return result;
				},
				onMutate: () => {
					popoverOpen = false;
				},
				onError: (error) => {
					toastOnError(error, 'Failed to sign out');
				},
			}),
		() => accountProfileQueryClient,
	);

	// The sync phase copy and dot tone are decided once here: the popover's
	// sync line renders the dot beside its label (the legend), the trigger
	// reuses the same dot, and the tooltip adds the action hint. Dot tones
	// are theme tokens (success connected, warning pulse in flight, muted
	// offline, destructive failed).
	const tooltip = $derived.by(() => {
		if (!isSignedIn) return 'Sign in';
		return 'Account';
	});
	// The dot is presence for work in flight, and nothing else now.
	//
	// It used to be presence for SYNC, reading a status this popover was handed.
	// That status was the superseded stack's, and the store's transport reports a
	// different thing entirely (connected, attempts, why it last reconnected), so
	// this is not a port waiting to be finished: it is a surface to design once
	// somebody decides what a person should be told about a transport that
	// reconnects on its own.
	const triggerDot = $derived.by(() => {
		if (!isSignedIn) return undefined;
		if (signOut.isPending) return 'bg-warning animate-pulse';
		return undefined;
	});

</script>

<Popover.Root bind:open={popoverOpen}>
	<Popover.Trigger>
		{#snippet child({ props })}
			{#if trigger}
				{@render trigger({ props })}
			{:else}
				<Button
					{...props}
					variant="ghost"
					size="icon-sm"
					{tooltip}
					aria-label="Account"
				>
					<!-- Identity glyph stays fixed; the sync dot sits at its
					     bottom-right like a presence badge (top-right would read
					     as a notification). -->
					<span class="relative">
						<CircleUser
							class="size-4 {isSignedIn ? '' : 'text-muted-foreground'}"
						/>
						{#if triggerDot}
							<span
								class="absolute -right-0.5 -bottom-0.5 size-2 rounded-full {triggerDot}"
							></span>
						{/if}
					</span>
				</Button>
			{/if}
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		class="w-80 p-0"
		align="end"
	>
		{#if auth.state.status === 'signed-in'}
			<div class="p-4 space-y-3">
				<div class="space-y-1">
					<p class="text-sm font-medium">{accountLabel}</p>
				</div>
				<div class="border-t pt-3 flex flex-col gap-1">
					{#if auth.accountManagementUrl}
						<Button
							href={auth.accountManagementUrl(auth.state.account, 'account').href}
							target="_blank"
							rel="noopener noreferrer"
							variant="ghost"
							size="sm"
							class="w-full justify-start"
							onclick={() => (popoverOpen = false)}
						>
							<ExternalLink class="size-3.5" />
							Manage account
							<span class="sr-only">(opens in browser)</span>
						</Button>
					{/if}
					<Button
						variant="ghost"
						size="sm"
						class="w-full justify-start"
						onclick={() => signOut.mutate()}
						disabled={signOut.isPending}
					>
						<LogOut class="size-3.5" />
						Sign out
					</Button>
				</div>

			</div>
		{:else}
			<div class="p-4">
					<SignInPanel {auth} {syncNoun} />
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>
