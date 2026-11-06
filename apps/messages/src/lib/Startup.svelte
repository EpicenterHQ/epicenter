<!--
	Messages' startup (decision 94): asks whether Messages' local program
	serves this page, before the app renders, under the layout's boundary.
	It answers without Beeper, so your replies open whether or not Beeper is
	running; when nothing answers, the app runs the fictional demo.
-->
<script lang="ts">
	import { servedLocally } from './backend.js';
	import MessagesApp from './MessagesApp.svelte';

	const local = await servedLocally();
</script>

<MessagesApp servedLocally={local} />
