/** The `@epicenter/app` a compiled `epicenter` carries; `scripts/compile.ts` makes it. */
declare module 'epicenter:app-package' {
	const carried: import('./app-package.ts').AppPackageFiles;
	export default carried;
}
