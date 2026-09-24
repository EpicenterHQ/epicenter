<script lang="ts">
	import { onMount } from 'svelte';
	let message = $state('Returning to Local Mail…');
	onMount(() => {
		if (!window.opener) {
			message =
				'Open Local Mail and connect Gmail again. This window did not start a connection.';
			return;
		}
		window.opener.postMessage(
			{ type: 'local-mail-gmail-return', url: location.href },
			location.origin,
		);
		message = 'You can close this window and return to Local Mail.';
	});
</script>

<svelte:head><title>Connecting | Local Mail</title></svelte:head>
<p class="p-8">{message}</p>
