---
name: control-flow
description: Linearize complex control flow with early returns, guard clauses, nested ifs, and natural-language conditions. Use when flattening nested conditions, linearizing try/catch logic, or separating mixed throw-and-return handlers, not for a broad "simplify this" pass over a diff or package, which belongs to collapse-pass.
metadata:
  author: epicenter
  version: '1.0'
---

# Human-Readable Control Flow

When refactoring complex control flow, mirror natural human reasoning patterns:

> **Related Skills**: See [refactoring methods](../collapse-pass/references/refactoring-methods.md) for branch collapse and caller evidence.

## Core Pattern

1. **Ask the human question first**: "Can I use what I already have?" -> early return for happy path
2. **Assess the situation**: "What's my current state and what do I need to do?" -> clear, mutually exclusive conditions
3. **Take action**: "Get what I need" -> consolidated logic at the end
4. **Use natural language variables**: `isUsingNavigator`, `isUsingLocalTranscription`, `needsOldFileCleanup`: names that read like thoughts
5. **Avoid artificial constructs**: No nested conditions that don't match how humans actually think through problems

Transform this: nested conditionals with duplicated logic
Into this: linear flow that mirrors human decision-making

## Example: Early Returns with Natural Language Variables

```typescript
// From apps/whispering/src/routes/(app)/_layout-utils/check-ffmpeg.ts

export async function checkFfmpegRecordingMethodCompatibility() {
	if (!window.__TAURI_INTERNALS__) return;

	// Only check if FFmpeg recording method is selected
	if (settings.value['recording.method'] !== 'ffmpeg') return;

	const { data: ffmpegInstalled } =
		await rpc.ffmpeg.checkFfmpegInstalled.ensure();
	if (ffmpegInstalled) return; // FFmpeg is installed, all good

	// FFmpeg recording method selected but not installed
	toast.warning('FFmpeg Required for FFmpeg Recording Method', {
		// ... toast content
	});
}
```

## Example: Natural Language Booleans

```typescript
// From apps/whispering/src/routes/(app)/_layout-utils/check-ffmpeg.ts

const isUsingNavigator = settings.value['recording.method'] === 'navigator';
const isUsingLocalTranscription =
	settings.value['transcription.selectedTranscriptionService'] ===
		'whispercpp' ||
	settings.value['transcription.selectedTranscriptionService'] === 'parakeet';

return isUsingNavigator && isUsingLocalTranscription && !isFFmpegInstalled;
```

## Example: Cleanup Check with Comment

```typescript
// From packages/epicenter/src/indexes/markdown/markdown-index.ts

/**
 * This is checking if there's an old filename AND if it's different
 * from the new one. It's essentially checking: "has the filename
 * changed?" and "do we need to clean up the old file?"
 */
const needsOldFileCleanup = oldFilename && oldFilename !== filename;
if (needsOldFileCleanup) {
	const oldFilePath = path.join(tableConfig.directory, oldFilename);
	await deleteMarkdownFile({ filePath: oldFilePath });
	tracking[table.name]!.deleteByFilename({ filename: oldFilename });
}
```

## Example: Linearizing try-catch into Guard + Happy Path

try-catch blocks create a nested, two-branch structure: the try body and the catch body. When only one call inside the try can actually throw, replace the try-catch with a guarded call + early return so the code reads top-to-bottom.

Before (nested, mixed throw/return):

```typescript
async ({ body, status }) => {
	const adapter = createAdapter(body.provider);

	try {
		const stream = chat({ adapter, messages: body.messages });
		return toServerSentEventsResponse(stream);
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw status(499, 'Client closed request');
		}
		const message = error instanceof Error ? error.message : 'Unknown error';
		throw status('Bad Gateway', `Provider error: ${message}`);
	}
};
```

After (linear, consistent returns):

```typescript
async ({ body, status }) => {
	const adapter = createAdapter(body.provider);

	const { data: stream, error: chatError } = trySync({
		try: () => chat({ adapter, messages: body.messages }),
		catch: (e) => Err(e instanceof Error ? e : new Error(String(e))),
	});

	if (chatError) {
		if (chatError.name === 'AbortError') {
			return status(499, 'Client closed request');
		}
		return status('Bad Gateway', `Provider error: ${chatError.message}`);
	}

	return toServerSentEventsResponse(stream);
};
```

The transformation follows the same human reasoning pattern:

1. **Try the risky thing**: wrap only what can fail
2. **Check if it failed**: early return with the appropriate error
3. **Continue with the happy path**: the rest of the function assumes success

This eliminates the nesting, makes `return` vs `throw` consistent, and separates the error boundary from the safe code that follows it.

## Example: Sequential Guards in a Handler

When a handler has multiple failure points, each guard follows the same pattern: do the thing, check the result, return early or continue.

```typescript
async ({ body, status }) => {
	// Guard 1: validate input
	if (!isSupportedProvider(body.provider)) {
		return status('Bad Request', `Unsupported provider: ${body.provider}`);
	}

	// Guard 2: resolve dependency
	const apiKey = resolveApiKey(body.provider, headers['x-api-key']);
	if (!apiKey) {
		return status('Unauthorized', 'Missing API key');
	}

	// Guard 3: risky operation
	const { data: stream, error } = trySync({
		try: () => chat({ adapter: createAdapter(body.provider, apiKey) }),
		catch: (e) => Err(e instanceof Error ? e : new Error(String(e))),
	});
	if (error) return status('Bad Gateway', error.message);

	// Happy path: all guards passed
	return toServerSentEventsResponse(stream);
};
```

Every guard has the same shape: check → return early on failure. The happy path accumulates at the bottom. Reading top-to-bottom, you see every way the function can fail before you see the success case.
