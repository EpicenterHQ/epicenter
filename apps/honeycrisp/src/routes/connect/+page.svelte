<script lang="ts">
	import { SignInScreen } from '@epicenter/app-shell/boot-screens';
	import { resolve } from '$app/paths';
	import { auth } from '#platform/auth';
</script>

<SignInScreen
	{auth}
	appName="Honeycrisp"
	noun="notes"
	onCancel={() => location.replace(resolve('/local'))}
/>
