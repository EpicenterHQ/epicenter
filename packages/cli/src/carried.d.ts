/** The `@epicenter/app` a compiled `epicenter` carries; `scripts/compile.ts` makes it. */
declare module 'epicenter:app-package' {
	const carried: import('./app-package.ts').AppPackageFiles;
	export default carried;
}

declare module '@epicenter/theme/theme.css' {
	const text: string;
	export default text;
}
