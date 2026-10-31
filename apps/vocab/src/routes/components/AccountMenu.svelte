<!--
	The account, under the signed-in layout: who is signed in, where their
	words and chats are, and Sign out. The one sign-in covers the learner's
	repository and Epicenter's hosted tutor models and dictation.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import CircleUser from '@lucide/svelte/icons/circle-user';
	import { auth } from '$lib/auth.svelte.js';

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

	async function signOut() {
		pending = true;
		problem = '';
		const { error } = await auth.signOut();
		if (error !== null) {
			problem = error.message;
			pending = false;
			return;
		}
		// The signed-in layout follows: it closes the repository and asks for a sign-in.
		pending = false;
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
		<p class="text-sm font-medium">{email || 'Signed in'}</p>
		<p class="text-xs leading-relaxed text-muted-foreground">
			Your words and chats are in your Epicenter repository, vocab, where your other devices and Epicenter's desktop app reach them. Nothing is kept in this browser. This account also provides hosted tutor models and dictation.
		</p>
		<div class="flex flex-col gap-1">
			{#if auth.accountManagementUrl && auth.state.status !== 'signed-out'}
				<Button href={auth.accountManagementUrl(auth.state.account, 'account').href} target="_blank" rel="noopener noreferrer" variant="ghost" size="sm" class="w-full justify-start">Manage account</Button>
			{/if}
			<Button variant="ghost" size="sm" class="w-full justify-start" disabled={pending} onclick={signOut}>Sign out</Button>
		</div>
		{#if problem}<p role="alert" class="text-xs text-destructive">{problem}</p>{/if}
	</Popover.Content>
</Popover.Root>
