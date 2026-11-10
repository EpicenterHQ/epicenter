<script lang="ts">
	import { page } from '$app/state';
	import MailList from '$lib/components/MailList.svelte';
	import MessagePage from '$lib/components/MessagePage.svelte';
</script>

{#if page.params.path?.startsWith('messages/')}
	<MessagePage />
{:else}
	<MailList />
{/if}
