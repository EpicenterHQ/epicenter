<script lang="ts">
	import { AuthError } from '@epicenter/auth';
	import { tryAsync } from 'wellcrafted/result';
	import type { ReactiveAuthClient } from '@epicenter/auth/svelte';
	import type { Snippet } from 'svelte';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Popover from '@epicenter/ui/popover';
	import { toast, toastOnError } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import CircleUser from '@lucide/svelte/icons/circle-user';
	import DatabaseZap from '@lucide/svelte/icons/database-zap';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import LogOut from '@lucide/svelte/icons/log-out';
	import {
		createMutation,
		createQuery,
		QueryClient,
	} from '@tanstack/svelte-query';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { resultMutationOptions, resultQueryOptions } from 'wellcrafted/query';
	import SignInPanel from './sign-in-panel.svelte';
	import { getConnectionScreen, getSignOut } from '../boot-screens/connection-screen-context.js';

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
		 * The app's auth client. Its connection
		 * supplies the selected server and live connection status.
		 */
		auth: ReactiveAuthClient;
		/** Noun describing what gets synced, e.g. "tabs" or "notes". */
		syncNoun: string;
		/**
		 * When set, the account actions that reload the page (sign in, sign out,
		 * and forget device) are disabled and this reason is shown, as the trigger
		 * tooltip and as a line inside the popover. The trigger itself stays
		 * openable so the reason is discoverable (a disabled trigger swallows hover,
		 * hiding the one message that matters). Lets a host block account changes at
		 * an unsafe moment, e.g. while a recording is in progress. Omit to leave it
		 * enabled.
		 */
		disabledReason?: string;
		/**
		 * If provided, exposes "Sign out and remove local data".
		 *
		 * The callback owns the ORDER, because only it can: capture the principal,
		 * close the session, clear the credential, then delete. Clearing before
		 * deleting is what makes an interrupted removal safe on a shared device.
		 * The next person meets a sign-in door rather than the owner's notes, and
		 * the owner, signing back in, sees what is left and removes again.
		 *
		 * **Pass it only when the callback removes all of this account's local
		 * data.** The copy below promises that everything online is safe and
		 * everything local is gone. Whispering's browser build passes it, with a
		 * callback that erases the audio after the replica; its desktop build
		 * withholds it because the host's audio is not scoped by principal, so
		 * the second half would be false there.
		 *
		 * Throw to report a failure; the popover catches it and shows it. There is
		 * no recovery screen and no removal record: removal is idempotent, so a
		 * retry is the same call and it finishes the job.
		 */
		onRemoveLocalData?: () => void | Promise<void>;
		/** Optional replacement for the compact account icon trigger. */
		trigger?: Snippet<[{ props: Record<string, unknown> }]>;
	};

	let {
		auth,
		syncNoun,
		onRemoveLocalData,
		disabledReason,
		trigger,
	}: AccountPopoverProps = $props();

	let popoverOpen = $state(false);
	const openConnection = getConnectionScreen();
	const leaveAndSignOut = getSignOut();
	let removing = $state(false);
	const isSignedIn = $derived(auth.state.status === 'signed-in');
	// The app can refuse account actions while capture is active.
	const accountLocked = $derived(!!disabledReason);
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
					if (leaveAndSignOut) {
						return tryAsync({ try: leaveAndSignOut, catch: (cause) => AuthError.SignOutFailed({ cause }) });
					}
					return auth.signOut();
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
		if (disabledReason) return disabledReason;
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

	function removeLocalData() {
		if (!onRemoveLocalData) return;
		popoverOpen = false;
		confirmationDialog.open({
			title: 'Sign out and remove local data?',
			// What survives, what does not, and what this never touches, in that
			// order. The account keeps everything that reached it, so the only loss
			// is work this device never managed to send, and a person deciding this
			// should be told which half is which. Do not call it a cache: the thing
			// being removed may be the only copy.
			description: `This signs you out and removes this account’s ${syncNoun} from this device. Anything already synced to your account stays there; anything not yet synced is gone. Files you exported and folders you chose are untouched.`,
			confirm: { text: 'Sign out and remove', variant: 'destructive' },
			onConfirm: async () => {
				removing = true;
				try {
					await onRemoveLocalData();
					window.location.reload();
				} catch (error) {
					toast.error('Could not remove this device’s data', {
						description: extractErrorMessage(error),
					});
				} finally {
					removing = false;
				}
			},
		});
	}
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
				{#if disabledReason}
					<p class="text-xs text-muted-foreground">{disabledReason}</p>
				{/if}
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
						disabled={accountLocked}
					>
						<LogOut class="size-3.5" />
						Sign out
					</Button>
				</div>
				{#if onRemoveLocalData}
					<div class="border-t pt-3">
						<Button
							variant="ghost-destructive"
							size="sm"
							class="w-full justify-start"
							onclick={removeLocalData}
							disabled={removing || accountLocked}
						>
							{#if removing}
								<Spinner class="size-3.5" />
							{:else}
								<DatabaseZap class="size-3.5" />
							{/if}
							Sign out and remove local data
						</Button>
					</div>
				{/if}
			</div>
		{:else}
			<div class="p-4">
					<SignInPanel {auth} {syncNoun} {disabledReason} />
			</div>
		{/if}
		{#if openConnection && auth.state.status === 'signed-in'}
			<div class="px-4 pb-4"><Button variant="outline" class="w-full" onclick={openConnection} disabled={accountLocked}>Change connection</Button></div>
		{/if}
	</Popover.Content>
</Popover.Root>
