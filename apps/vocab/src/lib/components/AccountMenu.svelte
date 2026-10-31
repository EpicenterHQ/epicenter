<!--
	The account: who is signed in, what the account does in this build
	(`auth.purpose`), and Sign out. On the web the one sign-in covers the
	learner's repository and Epicenter's hosted tutor models and dictation,
	and this shows only signed in; in the desktop window signing in is
	optional and only adds the hosted models and dictation, so signed out it
	offers Sign in.
-->
<script lang="ts">
	import { auth } from '#platform/auth';
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import CircleUser from '@lucide/svelte/icons/circle-user';

	let open = $state(false);
	let pending = $state(false);
	let problem = $state('');
	let email = $state('');

	$effect(() => {
		if (!open || auth.state.status === 'signed-out') return;
		let current = true;
		void auth.getProfile().then(({ data: profile, error }) => {
			if (current) email = error === null ? (profile.email ?? '') : '';
		});
		return () => {
			current = false;
		};
	});

	async function signIn() {
		pending = true;
		problem = '';
		const { error } = await auth.startSignIn();
		pending = false;
		if (error !== null) problem = error.message;
	}

	async function signOut() {
		pending = true;
		problem = '';
		const { error } = await auth.signOut();
		pending = false;
		// The root follows a sign-out: on the web it closes the repository and asks for a sign-in.
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
		{#if auth.state.status === 'signed-out'}
			<p class="text-sm font-medium">Sign in is optional</p>
			<p class="text-xs leading-relaxed text-muted-foreground">{auth.purpose.signedOut}</p>
			<Button class="w-full" size="sm" disabled={pending} onclick={signIn}>{pending ? 'Signing in…' : 'Sign in'}</Button>
		{:else}
			<p class="text-sm font-medium">{email || 'Signed in'}</p>
			<p class="text-xs leading-relaxed text-muted-foreground">{auth.purpose.signedIn}</p>
			<div class="flex flex-col gap-1">
				{#if auth.accountManagementUrl}
					<Button href={auth.accountManagementUrl(auth.state.account, 'account').href} target="_blank" rel="noopener noreferrer" variant="ghost" size="sm" class="w-full justify-start">Manage account</Button>
				{/if}
				<Button variant="ghost" size="sm" class="w-full justify-start" disabled={pending} onclick={signOut}>Sign out</Button>
			</div>
		{/if}
		{#if problem}<p role="alert" class="text-xs text-destructive">{problem}</p>{/if}
	</Popover.Content>
</Popover.Root>
