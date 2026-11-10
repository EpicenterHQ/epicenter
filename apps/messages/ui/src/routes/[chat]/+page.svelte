<script lang="ts">
	import { page } from '$app/state';
	import Conversation from '$lib/Conversation.svelte';
</script>

{#key page.params.chat}
	<Conversation chat={page.params.chat!} />
{/key}
