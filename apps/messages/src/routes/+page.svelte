<!--
	Messages over its folder (ADR-0766): `<WhenOpen>` shows a spinner while
	the drafts' directory opens through Messages' program, Recovery when it
	cannot, and the app once it has, and asks before the page is left while
	a save is out. Messages never signs in, so nothing uploads.
-->
<script lang="ts">
	import WhenOpen from '@epicenter/svelte/when-open';
	import { folder } from '$lib/app.js';
	import MessagesApp from '$lib/MessagesApp.svelte';
</script>

<WhenOpen app="Messages" {folder}><MessagesApp /></WhenOpen>
