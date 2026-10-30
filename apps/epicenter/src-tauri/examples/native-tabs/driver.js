// Test-only driver injected into the real Todos host build. Navigation to
// this reserved host is intercepted and refused by the smoke shell.
globalThis.nativeTabsSmokeInstance = crypto.randomUUID();
globalThis.nativeTabsSmoke = async (body) => {
	let report;
	try {
		report = {
			data: await new Function(`return (async () => { ${body} })()`)(),
		};
	} catch (error) {
		report = {
			error: `${error}\n${error?.stack ?? ''}\n${document.body?.innerText ?? ''}`,
		};
	}
	location.href = `https://native-tabs.invalid/report?result=${encodeURIComponent(JSON.stringify(report))}`;
};
