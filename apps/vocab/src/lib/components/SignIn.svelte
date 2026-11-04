<!--
	The web app's page while signed out: Vocab keeps none of the learner's
	words or chats in the browser (ADR-0700), so they are the learner's
	repository, behind sign-in. The same sign-in covers the hosted tutor and
	dictation. Signing in leaves the page and comes back to a new one.
-->
<script lang="ts">
	import { accountPurpose } from '#platform/account';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';
	import { account } from '../app.js';

	async function startSignIn() {
		// A successful start leaves this page for the sign-in page.
		const { error } = await account.startSignIn();
		if (error !== null) toast.error('Could not sign in', { description: error.message });
	}
</script>

<Empty.Root class="h-dvh">
	<Empty.Title>Vocab</Empty.Title>
	<Empty.Description>{accountPurpose.signedOut}</Empty.Description>
	<Button size="sm" onclick={() => void startSignIn()}>Sign in</Button>
</Empty.Root>
