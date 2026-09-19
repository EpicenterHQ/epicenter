<script lang="ts">
	import { AuthError } from '@epicenter/auth';
	import { tryAsync } from 'wellcrafted/result';
	import { getConnectionScreen, getSignOut } from '@epicenter/app-shell/boot-screens';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { toastOnError } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { createMutation } from '@tanstack/svelte-query';
	import LogOut from '@lucide/svelte/icons/log-out';
	import { resultMutationOptions } from 'wellcrafted/query';
	import { auth } from '$lib/auth.svelte.js';
	import { tauri } from '#platform/tauri';

	// Identity (email) is shown by the footer AccountPopover, which owns the
	// /api/session query. This page is for the sign in / sign out actions, so it
	// reads auth.state directly and does not re-fetch the profile.
	const isSignedIn = $derived(auth.state.status === 'signed-in');

	const openConnection = getConnectionScreen();
	const signOutApplication = getSignOut();

	const signOut = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['account', 'signOut'],
			mutationFn: () => tryAsync({
				try: async () => {
					if (!signOutApplication) throw new Error('Application sign-out is unavailable.');
					await signOutApplication();
				},
				catch: (cause) => AuthError.SignOutFailed({ cause }),
			}),
			onError: (error) => toastOnError(error, 'Failed to sign out'),
		}),
	);
</script>

<svelte:head> <title>Account - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>Account</Field.Legend>
	<Field.Description>
		Sign in to your Epicenter account. Whispering works fully offline without
		one; your account is what device sync will use.
	</Field.Description>
	<Field.Separator />

	<Field.Group>
		{#if isSignedIn}
			<Field.Field orientation="horizontal">
				<Field.Content>
					<Field.Label>Signed in</Field.Label>
					<Field.Description>
						Your Epicenter account is connected on this device.
					</Field.Description>
				</Field.Content>
				<Button
					variant="outline"
					onclick={() => signOut.mutate()}
					disabled={signOut.isPending}
				>
					{#if signOut.isPending}
						<Spinner class="size-4" />
					{:else}
						<LogOut class="size-4" />
					{/if}
					Sign out
				</Button>
			</Field.Field>
		{:else}
			<Field.Field>
				<Button
					class="w-full sm:w-auto sm:self-start"
					onclick={openConnection}
				>
					{#if auth.state.status === 'reauth-required'}
						Reconnect
					{:else}
						Sign in with Epicenter
					{/if}
				</Button>
			</Field.Field>
		{/if}
	</Field.Group>

	<Field.Separator />

	<Field.Set>
		<Field.Legend variant="label">Sync</Field.Legend>
		<Field.Description>
			{#if tauri}
				On the desktop, your recordings and settings stay on this computer
				for now; signing in powers hosted transcription. Use Whispering in
				the browser to sync them across devices.
			{:else}
				While signed in, your recordings, transcripts, and settings sync
				across your devices. Audio files stay on the device that recorded
				them. Live sync status shows in the account menu in the sidebar.
			{/if}
		</Field.Description>
	</Field.Set>
</Field.Set>
