<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import CircleUser from '@lucide/svelte/icons/circle-user';
	import { auth } from '$lib/auth.svelte.js';

	// Sign-in is optional here. An account uploads this browser's words and
	// chats to the learner's repository ("Synced"), and adds Epicenter's
	// hosted models.
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
		// A successful start leaves this page for the sign-in page.
		const { error } = await auth.startSignIn();
		if (error !== null) {
			problem = error.message;
			pending = false;
		}
	}
	async function signOut() {
		pending = true;
		problem = '';
		const { error } = await auth.signOut();
		if (error !== null) {
			problem = error.message;
			pending = false;
			return;
		}
		// The page follows: "On this device" stays, and "Synced" asks for a sign-in.
		pending = false;
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="icon-sm" aria-label="Account">
				<CircleUser class="size-4 {auth.state.status === 'signed-out' ? 'text-muted-foreground' : ''}" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80 space-y-3 p-4" align="end">
		{#if auth.state.status === 'signed-out'}
			<p class="text-sm font-medium">Sign in is optional</p>
			<p class="text-xs leading-relaxed text-muted-foreground">
				Your words and chats are saved in this browser. Signing in uploads them to your Epicenter repository, shown under Synced, where your other devices and Epicenter's desktop app reach them, and adds Epicenter's hosted tutor models.
			</p>
			<Button class="w-full" disabled={pending} onclick={signIn}>{pending ? 'Signing in…' : 'Sign in'}</Button>
		{:else}
			<p class="text-sm font-medium">{email || 'Signed in'}</p>
			<p class="text-xs leading-relaxed text-muted-foreground">
				Words and chats saved on this device upload to your repository on their own, then show under Synced. This account also provides hosted tutor models.
			</p>
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
