/**
 * How `svelte-check` compiles this package. An app compiles these
 * components with its own options, which must match: `desktop-startup`
 * awaits its roots at the top level, under the app's `<svelte:boundary>`.
 */
export default {
	compilerOptions: { experimental: { async: true } },
};
