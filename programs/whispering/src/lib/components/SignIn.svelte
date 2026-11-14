<!--
	The page while signed out, where the folder is the person's repository
	(ADR-0786): Whispering keeps nothing in the browser, so its recordings
	are the repository's, behind sign-in. The same sign-in covers hosted
	transcription and AI. Signing in leaves the page and comes back to a new
	one.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from 'svelte-sonner';
	import { account } from '../app.js';

	async function signIn() {
		const { error } = await account.startSignIn();
		if (error !== null) toast.error('Could not sign in', { description: error.message });
	}
</script>

<Empty.Root class="h-dvh">
	<Empty.Title>Whispering</Empty.Title>
	<Empty.Description>Sign in to record into your Epicenter repository. Nothing is kept in this browser.</Empty.Description>
	<Button size="sm" onclick={() => void signIn()}>Sign in</Button>
</Empty.Root>
