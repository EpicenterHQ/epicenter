import * as Y from '@y/y';

// UUID polyfill for non-secure contexts (HTTP)
function generateUUID(): string {
	if (typeof crypto !== 'undefined' && crypto.randomUUID) {
		try {
			return crypto.randomUUID();
		} catch {
			// Falls through to fallback
		}
	}
	// Fallback for non-secure contexts
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

// Global state
let doc: Y.Doc | null = null;
let isRunning = false;
let shouldStop = false;
let totalRowsInserted = 0;

function getRequiredElement<T extends Element>(id: string): T {
	const element = document.getElementById(id);
	if (!element) {
		throw new Error(`Missing required element: ${id}`);
	}
	return element as T;
}

// DOM elements
const elements = {
	docSize: getRequiredElement<HTMLElement>('docSize'),
	totalRows: getRequiredElement<HTMLElement>('totalRows'),
	memoryUsage: getRequiredElement<HTMLElement>('memoryUsage'),
	writeSpeed: getRequiredElement<HTMLElement>('writeSpeed'),
	encodeTime: getRequiredElement<HTMLElement>('encodeTime'),
	decodeTime: getRequiredElement<HTMLElement>('decodeTime'),
	bytesPerRow: getRequiredElement<HTMLElement>('bytesPerRow'),
	loadTime3g: getRequiredElement<HTMLElement>('loadTime3g'),
	progressFill: getRequiredElement<HTMLElement>('progressFill'),
	logContent: getRequiredElement<HTMLElement>('logContent'),
	runBtn: getRequiredElement<HTMLButtonElement>('runBtn'),
	stopBtn: getRequiredElement<HTMLButtonElement>('stopBtn'),
	networkUrl: getRequiredElement<HTMLElement>('network-url'),
};

// Show network URL for phone access
const host = window.location.hostname;
const port = window.location.port;
elements.networkUrl.textContent = `http://${host}:${port}`;

// Utility functions
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatNumber(n: number): string {
	return n.toLocaleString();
}

function log(
	message: string,
	type: 'info' | 'success' | 'warning' | 'error' = 'info',
) {
	const entry = document.createElement('div');
	entry.className = `log-entry ${type}`;
	entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
	elements.logContent.insertBefore(entry, elements.logContent.firstChild);

	// Keep only last 100 entries
	while (elements.logContent.children.length > 100) {
		const lastChild = elements.logContent.lastChild;
		if (!lastChild) break;
		elements.logContent.removeChild(lastChild);
	}
}

function getMemoryUsage(): string {
	if ('memory' in performance) {
		const memory = (
			performance as Performance & { memory: { usedJSHeapSize: number } }
		).memory;
		return formatBytes(memory.usedJSHeapSize);
	}
	return 'N/A (not Chrome)';
}

function updateStats() {
	if (!doc) return;

	const startEncode = performance.now();
	const encoded = Y.encodeStateAsUpdate(doc);
	const encodeTime = performance.now() - startEncode;

	const docSizeBytes = encoded.length;
	const docSizeMB = docSizeBytes / (1024 * 1024);

	elements.docSize.textContent = formatBytes(docSizeBytes);
	elements.totalRows.textContent = formatNumber(totalRowsInserted);
	elements.memoryUsage.textContent = getMemoryUsage();
	elements.encodeTime.textContent = `${encodeTime.toFixed(0)} ms`;

	if (totalRowsInserted > 0) {
		elements.bytesPerRow.textContent = `${(docSizeBytes / totalRowsInserted).toFixed(0)} B`;
	}

	// Estimate 3G load time (assuming 384 kbps = 48 KB/s)
	const loadTime3gSeconds = docSizeBytes / (48 * 1024);
	if (loadTime3gSeconds < 60) {
		elements.loadTime3g.textContent = `${loadTime3gSeconds.toFixed(0)} sec`;
	} else {
		elements.loadTime3g.textContent = `${(loadTime3gSeconds / 60).toFixed(1)} min`;
	}

	// Update progress bar (scale: 0-50 MB)
	const progressPercent = Math.min((docSizeMB / 50) * 100, 100);
	elements.progressFill.style.width = `${progressPercent}%`;

	// Color code doc size
	elements.docSize.className = 'stat-value';
	if (docSizeMB > 20) {
		elements.docSize.classList.add('danger');
	} else if (docSizeMB > 10) {
		elements.docSize.classList.add('warning');
	} else {
		elements.docSize.classList.add('success');
	}

	// Test decode time
	const startDecode = performance.now();
	const testDoc = new Y.Doc();
	Y.applyUpdate(testDoc, encoded);
	const decodeTime = performance.now() - startDecode;
	elements.decodeTime.textContent = `${decodeTime.toFixed(0)} ms`;
	testDoc.destroy();
}

function generateRandomString(length: number): string {
	const chars =
		'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ';
	let result = '';
	for (let i = 0; i < length; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
}

function generateRow(
	fieldsPerRow: number,
	fieldSize: number,
): Record<string, unknown> {
	const row: Record<string, unknown> = {
		id: generateUUID(),
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	for (let i = 0; i < fieldsPerRow; i++) {
		row[`field_${i}`] = generateRandomString(fieldSize);
	}

	return row;
}

async function runBenchmark() {
	if (isRunning) return;

	try {
		const numTables = parseInt(
			(document.getElementById('numTables') as HTMLInputElement).value,
			10,
		);
		const rowsPerTable = parseInt(
			(document.getElementById('rowsPerTable') as HTMLInputElement).value,
			10,
		);
		const fieldsPerRow = parseInt(
			(document.getElementById('fieldsPerRow') as HTMLInputElement).value,
			10,
		);
		const fieldSize = parseInt(
			(document.getElementById('fieldSize') as HTMLInputElement).value,
			10,
		);
		const batchSize = parseInt(
			(document.getElementById('batchSize') as HTMLInputElement).value,
			10,
		);

		isRunning = true;
		shouldStop = false;
		elements.runBtn.disabled = true;
		elements.stopBtn.disabled = false;

		// Initialize doc if needed
		if (!doc) {
			doc = new Y.Doc();
			totalRowsInserted = 0;
		}

		const totalRows = numTables * rowsPerTable;
		log(
			`Starting benchmark: ${numTables} tables × ${formatNumber(rowsPerTable)} rows = ${formatNumber(totalRows)} total rows`,
			'info',
		);
		log(
			`Config: ${fieldsPerRow} fields/row, ${fieldSize} chars/field, batch size ${batchSize}`,
			'info',
		);

		const overallStart = performance.now();
		let totalBatches = 0;

		for (
			let tableIndex = 0;
			tableIndex < numTables && !shouldStop;
			tableIndex++
		) {
			const tableName = `table_${tableIndex}`;
			const tableMap = doc.get(tableName);

			log(
				`Creating table ${tableIndex + 1}/${numTables}: ${tableName}`,
				'info',
			);
			const tableStart = performance.now();

			for (
				let rowIndex = 0;
				rowIndex < rowsPerTable && !shouldStop;
				rowIndex += batchSize
			) {
				const batchStart = performance.now();
				const actualBatchSize = Math.min(batchSize, rowsPerTable - rowIndex);

				// Batch the writes in a transaction
				doc.transact(() => {
					for (let i = 0; i < actualBatchSize; i++) {
						const row = generateRow(fieldsPerRow, fieldSize);
						const rowMap = new Y.Node();
						for (const [key, value] of Object.entries(row)) {
							rowMap.setAttr(key, value);
						}
						tableMap.setAttr(row.id as string, rowMap);
						totalRowsInserted++;
					}
				});

				totalBatches++;
				const batchTime = performance.now() - batchStart;
				const rowsPerSecond = (actualBatchSize / batchTime) * 1000;

				elements.writeSpeed.textContent = `${formatNumber(Math.round(rowsPerSecond))}/s`;
				elements.totalRows.textContent = formatNumber(totalRowsInserted);

				// Update stats every 5 batches
				if (totalBatches % 5 === 0) {
					updateStats();
				}

				// Yield to UI
				await new Promise((resolve) => setTimeout(resolve, 0));
			}

			const tableTime = performance.now() - tableStart;
			log(
				`Table ${tableName}: ${formatNumber(rowsPerTable)} rows in ${(tableTime / 1000).toFixed(2)}s`,
				'success',
			);
		}

		const totalTime = performance.now() - overallStart;
		updateStats();

		if (shouldStop) {
			log(
				`Benchmark stopped. Inserted ${formatNumber(totalRowsInserted)} rows.`,
				'warning',
			);
		} else {
			log(
				`Benchmark complete! ${formatNumber(totalRowsInserted)} rows in ${(totalTime / 1000).toFixed(2)}s`,
				'success',
			);
			log(
				`Average: ${formatNumber(Math.round((totalRowsInserted / totalTime) * 1000))} rows/sec`,
				'success',
			);
		}

		isRunning = false;
		elements.runBtn.disabled = false;
		elements.stopBtn.disabled = true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log(`ERROR: ${message}`, 'error');
		console.error('Benchmark error:', error);
		isRunning = false;
		elements.runBtn.disabled = false;
		elements.stopBtn.disabled = true;
	}
}

function stopBenchmark() {
	shouldStop = true;
	log('Stopping benchmark...', 'warning');
}

function resetDoc() {
	if (doc) {
		doc.destroy();
	}
	doc = new Y.Doc();
	totalRowsInserted = 0;

	elements.docSize.textContent = '0 KB';
	elements.totalRows.textContent = '0';
	elements.writeSpeed.textContent = '-';
	elements.encodeTime.textContent = '-';
	elements.decodeTime.textContent = '-';
	elements.bytesPerRow.textContent = '-';
	elements.loadTime3g.textContent = '-';
	elements.progressFill.style.width = '0%';
	elements.docSize.className = 'stat-value';

	log('Document reset', 'info');
}

function downloadDoc() {
	if (!doc) {
		log('No document to download', 'error');
		return;
	}

	const encoded = Y.encodeStateAsUpdate(doc);
	const blob = new Blob([encoded], { type: 'application/octet-stream' });
	const url = URL.createObjectURL(blob);

	const a = document.createElement('a');
	a.href = url;
	a.download = `benchmark-${totalRowsInserted}-rows.yjs`;
	a.click();

	URL.revokeObjectURL(url);
	log(`Downloaded ${formatBytes(encoded.length)} document`, 'success');
}

function clearLog() {
	elements.logContent.innerHTML = '<div class="log-entry">Log cleared</div>';
}

// Presets
const presets = {
	small: { tables: 1, rows: 1000, fields: 5, fieldSize: 30, batch: 200 },
	medium: { tables: 5, rows: 5000, fields: 10, fieldSize: 50, batch: 500 },
	large: { tables: 20, rows: 10000, fields: 10, fieldSize: 50, batch: 500 },
	huge: { tables: 50, rows: 20000, fields: 15, fieldSize: 100, batch: 500 },
};

function applyPreset(name: keyof typeof presets) {
	const preset = presets[name];
	(document.getElementById('numTables') as HTMLInputElement).value = String(
		preset.tables,
	);
	(document.getElementById('rowsPerTable') as HTMLInputElement).value = String(
		preset.rows,
	);
	(document.getElementById('fieldsPerRow') as HTMLInputElement).value = String(
		preset.fields,
	);
	(document.getElementById('fieldSize') as HTMLInputElement).value = String(
		preset.fieldSize,
	);
	(document.getElementById('batchSize') as HTMLInputElement).value = String(
		preset.batch,
	);

	const totalRows = preset.tables * preset.rows;
	log(
		`Applied "${name}" preset: ${preset.tables} tables × ${formatNumber(preset.rows)} rows = ${formatNumber(totalRows)} total`,
		'info',
	);
}

// Expose functions to window for onclick handlers
declare global {
	interface Window {
		runBenchmark: typeof runBenchmark;
		stopBenchmark: typeof stopBenchmark;
		resetDoc: typeof resetDoc;
		downloadDoc: typeof downloadDoc;
		clearLog: typeof clearLog;
		applyPreset: typeof applyPreset;
	}
}

window.runBenchmark = runBenchmark;
window.stopBenchmark = stopBenchmark;
window.resetDoc = resetDoc;
window.downloadDoc = downloadDoc;
window.clearLog = clearLog;
window.applyPreset = applyPreset;

// Initialize
resetDoc();
log('Benchmark ready. Select a preset or configure manually.', 'info');
