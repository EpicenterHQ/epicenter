<!-- PROTOTYPE. Tries to read the folder's client from outside `<Opening>`, during setup. -->
<script lang="ts">
	import { getApp } from './app.js';

	const { folder } = getApp();
	let seen = $state('');
	try {
		seen = `peek read a client: ${typeof folder.client()}`;
	} catch (error) {
		seen = `peek threw: ${(error as Error).message}`;
	}
</script>

<p data-testid="peek">{seen}</p>
