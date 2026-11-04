<!--
	The account: who is signed in, what the account does in this build
	(`accountPurpose`), and Sign out. On the web the one sign-in covers the
	learner's repository and Epicenter's hosted tutor models and dictation,
	and this shows only signed in; in the desktop window signing in is
	optional and only adds the hosted models and dictation, so signed out it
	offers Sign in.
-->
<script lang="ts">
	import { accountPurpose } from '#platform/account';
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import CircleUser from '@lucide/svelte/icons/circle-user';
	import { account } from '../app.js';

	let open = $state(false);
	let pending = $state(false);
	let problem = $state('');
	let email = $state('');
	const signIn = $derived(account.state());

	$effect(() => {
		if (!open || signIn.status === 'signed-out') return;
		let current = true;
		void account.getProfile().then(({ data: profile, error }) => {
			if (current) email = error === null ? (profile.email ?? '') : '';
		});
		return () => {
			current = false;
		};
	});

	async function startSignIn() {
		pending = true;
		problem = '';
		const { error } = await account.startSignIn();
		pending = false;
		if (error !== null) problem = error.message;
	}

	async function signOut() {
		pending = true;
		problem = '';
		const { error } = await account.signOut();
		pending = false;
		// The layout follows a sign-out: on the web it asks for a sign-in.
		if (error !== null) problem = error.message;
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="icon-sm" aria-label="Account">
				<CircleUser class="size-4" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80 space-y-3 p-4" align="end">
		{#if signIn.status === 'signed-out'}
			<p class="text-sm font-medium">Sign in is optional</p>
			<p class="text-xs leading-relaxed text-muted-foreground">{accountPurpose.signedOut}</p>
			<Button class="w-full" size="sm" disabled={pending} onclick={startSignIn}>{pending ? 'Signing in…' : 'Sign in'}</Button>
		{:else}
			<p class="text-sm font-medium">{email || 'Signed in'}</p>
			<p class="text-xs leading-relaxed text-muted-foreground">{accountPurpose.signedIn}</p>
			<div class="flex flex-col gap-1">
				{#if account.accountManagementUrl}
					<Button href={account.accountManagementUrl(signIn.account, 'account').href} target="_blank" rel="noopener noreferrer" variant="ghost" size="sm" class="w-full justify-start">Manage account</Button>
				{/if}
				<Button variant="ghost" size="sm" class="w-full justify-start" disabled={pending} onclick={signOut}>Sign out</Button>
			</div>
		{/if}
		{#if problem}<p role="alert" class="text-xs text-destructive">{problem}</p>{/if}
	</Popover.Content>
</Popover.Root>
