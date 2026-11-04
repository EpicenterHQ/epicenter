// Minimal Tabs test extension: save through the Epicenter engine, or keep
// the save in chrome.storage.local when no host answers, and hand it over later.
const HOST = 'so.epicenter.engine';

function native(message, host = HOST) {
	return new Promise((resolve) =>
		chrome.runtime.sendNativeMessage(host, message, (answer) => {
			const error = chrome.runtime.lastError;
			resolve(error ? { ok: false, hostError: error.message } : answer);
		}),
	);
}

async function saveTab(item) {
	const savedAt = new Date().toISOString();
	const answer = await native({ op: 'save', item: { ...item, savedAt } });
	if (answer.hostError === undefined) return answer;
	const { pending = [] } = await chrome.storage.local.get('pending');
	pending.push({ ...item, savedAt });
	await chrome.storage.local.set({ pending });
	return { ok: true, local: true, hostError: answer.hostError };
}

async function handOver() {
	const { pending = [] } = await chrome.storage.local.get('pending');
	const kept = [];
	for (const item of pending) {
		const answer = await native({ op: 'save', item });
		if (!answer.ok) kept.push(item);
	}
	await chrome.storage.local.set({ pending: kept });
	return { handedOver: pending.length - kept.length, kept: kept.length };
}

async function pending() {
	return (await chrome.storage.local.get('pending')).pending ?? [];
}

function port(messages) {
	return new Promise((resolve) => {
		const p = chrome.runtime.connectNative(HOST);
		const answers = [];
		const started = performance.now();
		p.onMessage.addListener((answer) => {
			answers.push(answer);
			if (answers.length === messages.length) {
				const ms = performance.now() - started;
				p.disconnect();
				resolve({ answers, ms });
			}
		});
		p.onDisconnect.addListener(() =>
			resolve({ answers, error: chrome.runtime.lastError?.message }),
		);
		for (const m of messages) p.postMessage(m);
	});
}

self.tabs = { native, saveTab, handOver, pending, port };
