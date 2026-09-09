import type { Account, AuthFetch } from '@epicenter/auth';
import OpenAI from 'openai';
import type { AiConfiguration } from './ai-configuration.js';

export type AiTransport = { baseURL: string; fetch: AuthFetch };
export type AppAi = ReturnType<typeof createAppAi>['value']['ai'];

/** The App supplies the admission gate; this owner drains HTTP bodies, not just headers. */
export function createAppAi({ lifetime, account, runtime, configuration, configuredFetch = globalThis.fetch.bind(globalThis) }: {
 lifetime: { assertUsable(): void; signal: AbortSignal };
 account: AiTransport | null;
 runtime: AiTransport | null;
 configuration: AiConfiguration | null;
 configuredFetch?: AuthFetch;
}) {
 const pending = new Set<Promise<void>>();
 const cleanupFailures: unknown[] = [];
 const clients = new Map<string, { baseUrl: string; apiKey?: string; client: OpenAI; retire(): void }>();

 async function cancelBody(body: { cancel(reason?: unknown): Promise<void> }, reason?: unknown) {
  try { await body.cancel(reason); } catch (cause) { cleanupFailures.push(cause); throw cause; }
 }

 function bind({ baseURL: suppliedBaseURL, fetch }: AiTransport, apiKey?: string) {
  const retired = new AbortController();
  const baseURL = suppliedBaseURL.replace(/\/+$/, '');
  const client = new OpenAI({
   baseURL, apiKey: 'transport-owned', dangerouslyAllowBrowser: true, maxRetries: 0,
   fetch: async (input, init) => {
    lifetime.assertUsable();
    retired.signal.throwIfAborted();
    const url = new URL(input instanceof Request ? input.url : input);
    if (!url.href.startsWith(`${baseURL}/`)) throw new Error('The client cannot change its inference destination.');
    const caller = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = AbortSignal.any([lifetime.signal, retired.signal, ...(caller ? [caller] : [])]);
    signal.throwIfAborted();
    const completion = Promise.withResolvers<void>();
    pending.add(completion.promise);
    const finish = () => { pending.delete(completion.promise); completion.resolve(); };
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.delete('authorization');
    if (apiKey?.trim()) headers.set('authorization', `Bearer ${apiKey.trim()}`);
    try {
     const response = await fetch(input, { ...init, headers, signal, credentials: 'omit', redirect: 'error' });
     if (signal.aborted) {
      if (response.body) await cancelBody(response.body);
      signal.throwIfAborted();
     }
     if (!response.body) { finish(); return response; }
     const reader = response.body.getReader();
     let controller: ReadableStreamDefaultController<Uint8Array>;
     let ended = false;
     const done = () => { ended = true; signal.removeEventListener('abort', abort); finish(); };
     const abort = () => {
      if (ended) return;
      ended = true;
      controller.error(caller?.aborted ? caller.reason : new Error('Inference access was retired.'));
      // Cancellation must settle before App close can release the library.
      void cancelBody(reader, signal.reason).then(done, done);
     };
     const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); },
      async pull(value) {
       try {
        const chunk = await reader.read();
        if (ended) return;
        signal.throwIfAborted();
        if (chunk.done) { value.close(); done(); } else value.enqueue(chunk.value);
       } catch (cause) { if (!ended) { value.error(caller?.aborted ? cause : new Error('Inference response failed.', { cause })); done(); } }
      },
      async cancel(reason) { if (ended) return; ended = true; try { await cancelBody(reader, reason); } finally { done(); } },
     }, { highWaterMark: 0 });
     return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (cause) { finish(); throw cause; }
   },
  });
  return { client, retire: () => retired.abort(new Error('AI connection was retired.')) };
 }

 function invalidate() {
  const current = configuration?.read() ?? [];
  for (const [id, cached] of clients) {
   const record = current.find(entry => entry.id === id);
   if (!record || record.baseUrl !== cached.baseUrl || record.apiKey !== cached.apiKey) {
    cached.retire(); clients.delete(id);
   }
  }
 }
 const unsubscribe = configuration?.onChange(invalidate);
 const { close: closeConfiguration, ...management } = configuration ?? {};
 const ai = Object.freeze({
  runtime: runtime ? Object.freeze({ client: bind(runtime).client }) : null,
  account: account ? Object.freeze({ client: bind(account).client }) : null,
  /** Local configuration management and observation; credentials never enter synced data. */
  configuration: configuration ? Object.freeze({
   ...management as Omit<AiConfiguration, 'close'>,
   /** Inspect a form candidate without persisting it; access still ends with this App. */
   preview({ baseUrl, apiKey }: { baseUrl: string; apiKey?: string }) {
    lifetime.assertUsable();
    return bind({ baseURL: baseUrl, fetch: configuredFetch }, apiKey).client;
   },
  }) : null,
  configured() {
   lifetime.assertUsable();
   return Object.freeze((configuration?.read() ?? []).map(record => {
    let cached = clients.get(record.id);
    if (!cached) {
     cached = { baseUrl: record.baseUrl, apiKey: record.apiKey, ...bind({ baseURL: record.baseUrl, fetch: configuredFetch }, record.apiKey) };
     clients.set(record.id, cached);
    }
    return Object.freeze({ id: record.id, name: record.name, client: cached.client });
   }));
  },
 });
 return {
  value: { ai },
  async close() {
   unsubscribe?.();
   try { closeConfiguration?.(); } catch (cause) { cleanupFailures.push(cause); }
   await Promise.allSettled(pending);
   if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'AI transport cleanup failed.');
   clients.clear();
  },
 };
}

/** Shipped Epicenter server profiles mount /v1 even when provider credentials are absent. */
export function accountInference(account: Account): AiTransport {
 return { baseURL: `${account.baseURL.replace(/\/+$/, '')}/v1`, fetch: account.fetch };
}
