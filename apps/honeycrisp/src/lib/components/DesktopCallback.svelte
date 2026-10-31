<!--
	The sign-in callback's page in the desktop window, which never signs in
	and never comes here; if something does send it here, it says so.
-->
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import type { CallbackProps } from '../platform.js';

	let { home }: CallbackProps = $props();
</script>

<Empty.Root class="h-dvh">
	<Empty.Title>Honeycrisp does not sign in here</Empty.Title>
	<Empty.Description>Honeycrisp on this computer keeps its notes in a folder; Epicenter syncs it.</Empty.Description>
	<a class="text-sm underline" href={home}>Back to Honeycrisp</a>
</Empty.Root>
