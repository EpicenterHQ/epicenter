<!--
	The sign-in callback's page in the desktop window, which signs in through
	the system browser and never comes here; if something does send it here,
	it says so.
-->
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import type { CallbackProps } from '../platform.js';

	let { home }: CallbackProps = $props();
</script>

<Empty.Root class="h-dvh">
	<Empty.Title>Vocab does not sign in here</Empty.Title>
	<Empty.Description>Vocab on this computer signs in through your browser, from its account menu.</Empty.Description>
	<a class="text-sm underline" href={home}>Back to Vocab</a>
</Empty.Root>
