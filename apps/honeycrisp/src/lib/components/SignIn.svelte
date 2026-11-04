<!--
	The web app's page while signed out: Honeycrisp keeps nothing in the
	browser (ADR-0700), so its notes are the person's repository, behind
	sign-in. Signing in leaves the page and comes back to a new one.
-->
<script lang="ts">
	import type { CallbackAuthClient } from '@epicenter/account';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';

	let { account }: { account: CallbackAuthClient } = $props();

	async function signIn() {
		const { error } = await account.startSignIn();
		if (error !== null) toast.error('Could not sign in', { description: error.message });
	}
</script>

<Empty.Root class="h-dvh">
	<Empty.Title>Honeycrisp</Empty.Title>
	<Empty.Description>Sign in to use the notes in your Epicenter repository.</Empty.Description>
	<Button size="sm" onclick={() => void signIn()}>Sign in</Button>
</Empty.Root>
