<!--
	Account management: profile, connected sign-in providers, and passkeys.

	Every mutation here can be refused by the server's fresh-session gate
	(SESSION_NOT_FRESH) because adding or removing a login method is sensitive;
	the remedy is always the same hosted re-sign-in, surfaced as a toast action.
	Different-email linking is deliberate: the confirm dialog names the current
	account email before the OAuth ceremony runs (the provider's own email is
	only known after the ceremony, so it cannot be named up front).
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import {
		ConfirmationDialog,
		confirmationDialog,
	} from '@epicenter/ui/confirmation-dialog';
	import { Input } from '@epicenter/ui/input';
	import { Separator } from '@epicenter/ui/separator';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { createQuery } from '@tanstack/svelte-query';
	import { onMount } from 'svelte';
	import { accountKeys } from '$lib/account/queries';
	import {
		type AuthError,
		isPasskeyCancellation,
		requiresReauth,
		supportsPasskeys,
	} from '$lib/auth/client';
	import {
		PROVIDER_LABELS,
		SOCIAL_PROVIDERS,
		type SocialProvider,
	} from '$lib/auth/providers';
	import ProviderButton from '$lib/auth/ProviderButton.svelte';
	import UserIdentity from '$lib/auth/UserIdentity.svelte';
	import { auth } from '$lib/platform/auth';
	import { getDashboard } from '$lib/dashboard/context';
	const { account, accountQueries, management: authClient, queryClient, signal } = getDashboard();

	const sessionQuery = createQuery(() => accountQueries.session.options);
	const linkedQuery = createQuery(() => accountQueries.linked.options);
	const passkeysQuery = createQuery(() => accountQueries.passkeys.options);

	const profile = $derived(sessionQuery.data?.user ?? null);
	const linkedAccounts = $derived(linkedQuery.data ?? []);
	const passkeys = $derived(passkeysQuery.data ?? []);

	// The rows are Better Auth's own, exposed unmapped: a handler's param is just
	// the element type of the list it acts on. There is no view model to name.
	type LinkedAccount = (typeof linkedAccounts)[number];
	type Passkey = (typeof passkeys)[number];
	// A provider already linked is not offered again: v1 stores no provider email
	// on the account row, so a second same-provider account would be
	// indistinguishable in the list (and the DB unique on (provider, account)
	// would reject a true duplicate anyway). Offer only the not-yet-linked ones.
	const linkedProviderIds = $derived(
		new Set(linkedAccounts.map((linkedAccount) => linkedAccount.providerId)),
	);
	const availableProviders = $derived(
		SOCIAL_PROVIDERS.filter((provider) => !linkedProviderIds.has(provider)),
	);
	// The server refuses to unlink the last account (it would leave no way in),
	// so the button is only offered when another account remains.
	const canUnlink = $derived(linkedAccounts.length > 1);
	const passkeysSupported = supportsPasskeys();

	let editingPasskeyId = $state<string | null>(null);
	let editingName = $state('');
	let renaming = $state(false);

	function providerLabel(providerId: string): string {
		return PROVIDER_LABELS[providerId as SocialProvider] ?? providerId;
	}

	function formatDate(value: Date | string): string {
		return new Date(value).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
		});
	}

	function invalidate(queryKey: readonly unknown[]) {
		queryClient.invalidateQueries({ queryKey });
	}

	// A failed OAuth link returns here (errorCallbackURL) with Better Auth's
	// `?error=<code>&error_description=<message>`. Surface it once, then strip the
	// params so a reload does not re-toast a stale failure.
	onMount(() => {
		const url = new URL(window.location.href);
		const code = url.searchParams.get('error');
		if (!code) return;
		const description = url.searchParams.get('error_description');
		toast.error(description || 'Could not connect that account. Please try again.');
		url.searchParams.delete('error');
		url.searchParams.delete('error_description');
		history.replaceState(null, '', url.pathname + url.search + url.hash);
	});

	function reauthToast() {
		toast.error('Sign in again to change your sign-in methods.', {
			action: {
				label: 'Sign in',
				onClick: async () => {
					if (signal.aborted) return;
					await auth.startSignIn({ reauthenticate: true });
				},
			},
		});
	}

	/**
	 * Surface a Better Auth error and report whether it is terminal. A 401/403
	 * (session gone or not fresh) is terminal: the remedy is re-auth elsewhere,
	 * so a confirm dialog should close. Anything else is retryable (the dialog
	 * stays open for another attempt).
	 */
	function reportError(error: AuthError, fallback: string): { terminal: boolean } {
		if (requiresReauth(error)) {
			reauthToast();
			return { terminal: true };
		}
		toast.error(error.message || fallback);
		return { terminal: false };
	}

	function connect(provider: SocialProvider) {
		const email = profile?.email ?? 'this account';
		const label = PROVIDER_LABELS[provider];
		confirmationDialog.open({
			title: `Connect ${label}`,
			description: `You're signed in as ${email}. Connect a ${label} account as another way to sign in? If its email differs from ${email}, it is still linked to this account.`,
			confirm: { text: 'Connect' },
			onConfirm: async () => {
				if (signal.aborted) return;
				const { data, error } = await authClient.linkSocial({
					provider,
					callbackURL: window.location.href,
					// Without this, a link failure AFTER the provider round trip lands
					// on Better Auth's default `/error` (which this app never mounts).
					// Return to this page instead; the on-mount reader below turns the
					// `?error`/`?error_description` it appends into a toast.
					errorCallbackURL: window.location.href,
				});
				if (signal.aborted) return;
				if (error) {
					reportError(error, `Could not connect ${label}.`);
					return;
				}
				// Leave for the provider; on return the linked list refetches.
				if (data?.url) window.location.href = data.url;
			},
		});
	}

	function disconnect(linkedAccount: LinkedAccount) {
		const label = providerLabel(linkedAccount.providerId);
		const email = profile?.email ?? 'this account';
		confirmationDialog.open({
			title: `Disconnect ${label}`,
			description: `Remove ${label} as a way to sign in to ${email}? You can reconnect it anytime.`,
			confirm: { text: 'Disconnect', variant: 'destructive' },
			onConfirm: async () => {
				const { error } = await authClient.unlinkAccount({
					providerId: linkedAccount.providerId,
					accountId: linkedAccount.accountId,
				});
				if (signal.aborted) return;
				if (error) {
					if (reportError(error, `Could not disconnect ${label}.`).terminal) {
						return;
					}
					throw error; // retryable: keep the dialog open
				}
				toast.success(`${label} disconnected`);
				invalidate(accountKeys.linked);
			},
		});
	}

	async function addPasskey() {
		const { error } = await authClient.passkey.addPasskey();
		if (signal.aborted) return;
		if (error) {
			if (isPasskeyCancellation(error)) return;
			if (requiresReauth(error)) {
				reauthToast();
				return;
			}
			toast.error(error.message || 'Could not add a passkey.');
			return;
		}
		toast.success('Passkey added');
		invalidate(accountKeys.passkeys);
	}

	function startRename(passkey: Passkey) {
		editingPasskeyId = passkey.id;
		editingName = passkey.name ?? '';
	}

	function cancelRename() {
		editingPasskeyId = null;
		editingName = '';
	}

	async function saveRename(passkey: Passkey) {
		const name = editingName.trim();
		if (!name || name === passkey.name) {
			cancelRename();
			return;
		}
		renaming = true;
		const { error } = await authClient.passkey.updatePasskey({
			id: passkey.id,
			name,
		});
		renaming = false;
		if (signal.aborted) return;
		if (error) {
			reportError(error, 'Could not rename this passkey.');
			return;
		}
		cancelRename();
		invalidate(accountKeys.passkeys);
	}

	/**
	 * Hosted account deletion (`DELETE /api/account`). The server deletes in a
	 * retry-safe order and answers 503 with the failed step on a partial
	 * failure, so the remedy is always "retry until 204". Only a 204 means the
	 * account is gone; afterwards we clear local auth before leaving the dashboard.
	 */
	function deleteAccount() {
		const email = profile?.email ?? 'this account';
		confirmationDialog.open({
			title: 'Delete account',
			description: `Permanently delete ${email} everywhere: synced workspaces, documents, uploaded files, billing, and every way to sign in. This cannot be undone. Data stored on your devices stays on your devices.`,
			confirm: { text: 'Delete forever', variant: 'destructive' },
			onConfirm: async () => {
				const response = await account.fetch('/api/account', {
					method: 'DELETE',
					credentials: 'omit',
					headers: { 'x-epicenter-principal': account.principalId },
				});
				if (signal.aborted) return;
				if (!response.ok) {
					if (response.status === 401 || response.status === 403) {
						// The route requires a fresh session; the remedy is the same
						// re-sign-in the other sensitive account changes use.
						reauthToast();
						return;
					}
					toast.error(
						response.status === 503
							? 'Deletion did not finish. Confirm again to retry until it completes.'
							: 'Could not delete your account. Please try again.',
					);
					throw new Error(`Account deletion answered ${response.status}`); // retryable: keep the dialog open
				}
				toast.success('Your account has been deleted');
				try {
					await auth.signOut();
				} catch {
					// The session was already destroyed with the account.
				}
				window.location.href = '/';
			},
		});
	}

	function deletePasskey(passkey: Passkey) {
		const label = passkey.name?.trim() || 'this passkey';
		confirmationDialog.open({
			title: 'Remove passkey',
			description: `Remove ${label}? You won't be able to sign in with it anymore.`,
			confirm: { text: 'Remove', variant: 'destructive' },
			onConfirm: async () => {
				const { error } = await authClient.passkey.deletePasskey({
					id: passkey.id,
				});
				if (signal.aborted) return;
				if (error) {
					if (reportError(error, 'Could not remove this passkey.').terminal) {
						return;
					}
					throw error; // retryable: keep the dialog open
				}
				toast.success('Passkey removed');
				invalidate(accountKeys.passkeys);
			},
		});
	}
</script>

<svelte:head><title>Account: Epicenter</title></svelte:head>

<div class="flex flex-col gap-6">
	<div>
		<h1 class="text-2xl font-semibold tracking-tight">Account</h1>
		<p class="text-sm text-muted-foreground">
			Manage how you sign in to Epicenter.
		</p>
	</div>

	<!-- Profile -->
	<Card.Root>
		<Card.Header>
			<Card.Title>Profile</Card.Title>
		</Card.Header>
		<Card.Content>
			{#if sessionQuery.isLoading}
				<Spinner class="size-4" />
			{:else if profile}
				<UserIdentity user={profile} />
			{/if}
		</Card.Content>
	</Card.Root>

	<!-- Connected accounts -->
	<Card.Root>
		<Card.Header>
			<Card.Title>Connected accounts</Card.Title>
			<Card.Description>
				Sign in with any connected provider. They all reach this one Epicenter
				account.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{#if linkedQuery.isLoading}
				<Spinner class="size-4" />
			{:else if linkedQuery.error}
				<Alert.Root variant="destructive">
					<CircleAlertIcon class="size-4" />
					<Alert.Description>
						{linkedQuery.error.message || 'Could not load connected accounts.'}
					</Alert.Description>
				</Alert.Root>
			{:else}
				<ul class="flex flex-col divide-y rounded-md border">
					{#each linkedAccounts as linkedAccount (linkedAccount.id)}
						<li class="flex items-center justify-between gap-3 px-4 py-3">
							<div class="flex flex-col">
								<span class="text-sm font-medium">
									{providerLabel(linkedAccount.providerId)}
								</span>
								<span class="text-xs text-muted-foreground">
									Connected {formatDate(linkedAccount.createdAt)}
								</span>
							</div>
							<Button
								variant="ghost"
								size="sm"
								disabled={!canUnlink}
								title={canUnlink
									? undefined
									: 'Connect another provider before disconnecting this one.'}
								onclick={() => disconnect(linkedAccount)}
							>
								Disconnect
							</Button>
						</li>
					{/each}
				</ul>
			{/if}

			{#if availableProviders.length > 0}
				<Separator />
				<div class="flex flex-col gap-3">
					<p class="text-sm font-medium">Connect another account</p>
					{#each availableProviders as provider (provider)}
						<ProviderButton
							{provider}
							label={`Connect ${PROVIDER_LABELS[provider]}`}
							onclick={() => connect(provider)}
						/>
					{/each}
				</div>
			{/if}
		</Card.Content>
	</Card.Root>

	<!-- Passkeys -->
	<Card.Root>
		<Card.Header>
			<Card.Title>Passkeys</Card.Title>
			<Card.Description>
				Sign in with your fingerprint, face, or device PIN. Passkeys are an
				extra way in; they never replace your connected accounts.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{#if passkeysQuery.isLoading}
				<Spinner class="size-4" />
			{:else if passkeysQuery.error}
				<Alert.Root variant="destructive">
					<CircleAlertIcon class="size-4" />
					<Alert.Description>
						{passkeysQuery.error.message || 'Could not load passkeys.'}
					</Alert.Description>
				</Alert.Root>
			{:else if passkeys.length > 0}
				<ul class="flex flex-col divide-y rounded-md border">
					{#each passkeys as passkey (passkey.id)}
						<li class="flex items-center justify-between gap-3 px-4 py-3">
							{#if editingPasskeyId === passkey.id}
								<Input
									class="h-8 max-w-56"
									bind:value={editingName}
									placeholder="Passkey name"
									disabled={renaming}
									onkeydown={(event) => {
										if (event.key === 'Enter') saveRename(passkey);
										if (event.key === 'Escape') cancelRename();
									}}
								/>
								<div class="flex items-center gap-1">
									<Button
										variant="ghost"
										size="sm"
										disabled={renaming}
										onclick={() => saveRename(passkey)}
									>
										{#if renaming}<Spinner class="size-3.5" />{:else}Save{/if}
									</Button>
									<Button
										variant="ghost"
										size="sm"
										disabled={renaming}
										onclick={cancelRename}
									>
										Cancel
									</Button>
								</div>
							{:else}
								<div class="flex flex-col">
									<div class="flex items-center gap-2">
										<span class="text-sm font-medium">
											{passkey.name?.trim() || 'Passkey'}
										</span>
										{#if passkey.backedUp}
											<Badge variant="secondary" class="text-[10px] px-1.5 py-0">
												Synced
											</Badge>
										{/if}
									</div>
									<span class="text-xs text-muted-foreground">
										Added {formatDate(passkey.createdAt)}
									</span>
								</div>
								<div class="flex items-center gap-1">
									<Button
										variant="ghost"
										size="icon"
										class="size-8"
										title="Rename passkey"
										onclick={() => startRename(passkey)}
									>
										<PencilIcon class="size-4" />
									</Button>
									<Button
										variant="ghost"
										size="icon"
										class="size-8 text-muted-foreground hover:text-destructive"
										title="Remove passkey"
										onclick={() => deletePasskey(passkey)}
									>
										<Trash2Icon class="size-4" />
									</Button>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-sm text-muted-foreground">No passkeys yet.</p>
			{/if}

			{#if passkeysSupported}
				<div>
					<Button variant="outline" onclick={addPasskey}>
						<FingerprintIcon class="size-4" />
						Add a passkey
					</Button>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>

	<!-- Danger zone -->
	<Card.Root class="border-destructive/50">
		<Card.Header>
			<Card.Title>Delete account</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			<p class="text-sm text-muted-foreground">
				Permanently deletes your synced workspaces, documents, uploaded files,
				billing, and every way to sign in. Data stored on your devices stays on
				your devices. This cannot be undone.
			</p>
			<div>
				<Button variant="destructive" onclick={deleteAccount}>
					<Trash2Icon class="size-4" />
					Delete account
				</Button>
			</div>
		</Card.Content>
	</Card.Root>
</div>

<ConfirmationDialog />
