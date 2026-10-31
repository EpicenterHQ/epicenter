<!--
	The sign-in callback's page in the desktop window, which never comes
	here: it signs in through the system browser, and the shell hears the
	answer itself. If something does send it here, it says so.
-->
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import type { CallbackProps } from '../platform/types.js';

	let { home }: CallbackProps = $props();
</script>

<Empty.Root class="h-dvh">
	<Empty.Title>Whispering does not sign in here</Empty.Title>
	<Empty.Description>Whispering on this computer signs in through your browser, from Settings.</Empty.Description>
	<a class="text-sm underline" href={home}>Back to Whispering</a>
</Empty.Root>
