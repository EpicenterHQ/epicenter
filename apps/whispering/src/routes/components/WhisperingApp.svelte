<!--
	What both views share, made once for the page and account: the services,
	the connections, the microphone, and the recorder, which keeps every
	recording on this device (`$lib/device.ts`). Each view's layout renders
	its pages under it (`WhisperingView`). It stops taking work when it
	leaves.
-->
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { onDestroy, type Snippet } from 'svelte';
	import { device } from '$lib/device.js';
	import { createWhispering, setWhispering } from '$lib/whispering.svelte.js';

	let { children }: { children: Snippet } = $props();

	const whispering = createWhispering({ device });
	setWhispering(whispering);
	const starting = whispering.start();
	// Leaving waits for nothing; a recording under way ends with the page.
	onDestroy(whispering.dispose);
</script>

{#await starting}
	<Loading class="h-dvh" label="Opening your recordings…" />
{:then}
	{@render children()}
{:catch error}
	<Empty.Root class="h-dvh">
		<Empty.Header>
			<Empty.Title>Whispering could not start</Empty.Title>
			<Empty.Description role="alert">{extractErrorMessage(error)}</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{/await}
