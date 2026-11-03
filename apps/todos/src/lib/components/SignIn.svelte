<!--
	`#platform/recovery` on the web: signed out, the world did not open.
	Sign-in leaves the page and comes back to a new one.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';
	import type { StartupFailure } from '../app.web.js';

	let { failure }: { failure: StartupFailure } = $props();

	async function signIn() {
		const { error } = await failure.signIn();
		if (error !== null) toast.error('Could not sign in', { description: error.message });
	}
</script>

<Empty.Root class="h-dvh">
	<Empty.Title>Todos</Empty.Title>
	<Empty.Description>Sign in to use the todos in your Epicenter repository.</Empty.Description>
	<Button size="sm" onclick={() => void signIn()}>Sign in</Button>
</Empty.Root>
