# Consultation example and evaluation

This is a hypothetical interaction, not a claim about Epicenter's current APIs
or a transcript of executed tests. The named example files belong to a fictional
fixture. A real brief includes excerpts and paths from the actual checkout.

## User to Codex

> Review the proposed storage API with Claude. Challenge the ownership model,
> test the recommendation, and implement it if it preserves close and reopen.

## Codex to Claude

You are the reviewer. Apply the repository's adversarial-review skill yourself.
Read additional files as needed; ask me for tests or benchmarks. I own execution.

We want tests to use the production App lifecycle with memory storage. Closing
one App must not erase data that a later App should reopen.

Current implementation, from the fixture's `src/open-app.ts`:

```ts
async function openApp({ definition }) {
  const connection = await openBrowserStore(definition.id);
  const producers = startProducers(connection);
  return {
    data: connection.data,
    async close() {
      await producers.close();
      await connection.close();
    },
  };
}
```

My proposed interface and caller:

```ts
type Runtime = {
  openStore(id: string): Promise<Connection>;
  close(): Promise<void>;
};

const runtime = createMemoryRuntime();
const first = await openApp({ definition, runtime });
await first.close();
const second = await openApp({ definition, runtime });
```

The proposed `App.close()` also calls `runtime.close()`.

```text
Test owns runtime
  |
  +-- opens App
        +-- starts producers
        +-- opens storage connection
        +-- close: producers -> connection -> runtime
```

My reasoning: one injected object makes production and test setup look alike.
My uncertainty: the object may bundle ownership that App should not have.
The reopen requirement is fixed; the runtime abstraction and names are proposals.

Start with `src/open-app.ts`, `src/storage.ts`, and `tests/reopen.test.ts`.
Treat this brief as evidence you can disprove. What would you build from the
desired outcome and actual callers if this abstraction did not exist? Show the
strongest concrete alternative, what disappears, and the costs it introduces.

## Claude to Codex

I read those files and `src/storage/memory.ts`, which the brief omitted. Its
`close()` clears the backing map. The proposed API gives App permission to
destroy something the caller intends to reuse.

I would supply storage that creates connections and leave backing-store disposal
with the caller:

```ts
const storage = createMemoryStorage();
const first = await openApp({ definition, storage });
await first.close();
const second = await openApp({ definition, storage });
```

```text
Caller owns backing storage
  |
  +-- App owns one connection
        +-- owns producers
        +-- close: producers -> connection
```

This removes `Runtime.close()` from the App contract. The cost is making the
connection/backing-storage distinction explicit in storage implementations.
Before adopting it, test that closing the first App stops observers while the
second App still reads the first App's data. A passing reopen test alone would
miss leaked producers.

## Codex to Claude, in the same session

I verified your reading of the memory store. I added the focused check within
the user's implementation request, then separated connection teardown from
backing-store disposal.

Command:

```bash
bun test ./tests/reopen.test.ts
```

Relevant raw output, before:

```text
Expected: "saved"
Received: undefined
0 pass
1 fail
```

After:

```text
(pass) close stops observers and preserves data for reopen
1 pass
0 fail
```

Only `src/open-app.ts`, `src/storage/memory.ts`, and the test changed. Here is
the revised close body; inspect those files to verify the implementation.

```ts
async close() {
  await producers.close();
  await connection.close();
}
```

Does this resolve your ownership objection? What does the test still fail to
establish?

## Claude to Codex

The revised ownership is coherent. The test establishes memory reopen and
observer shutdown; it does not establish teardown ordering in the browser
implementation. Read that implementation and run its existing lifecycle checks
before integrating. I see no reason to retain the broader Runtime contract.

## Codex to user

> I implemented storage injection with App-owned connections. Claude found that
> my proposed runtime let App destroy caller-owned data; a focused test reproduced
> the problem. The revised reopen test and existing browser lifecycle checks pass.
> The broader runtime interface was unnecessary.

## Evaluate the behavior

Run the same bounded task against the previous and updated skills in separate
contexts. Keep the source fixture and model fixed. Record the brief, responses,
commands, changes, elapsed time, and unmet checks. The scripted conversation
above illustrates the target; it is not a measured result or an answer key.

| Case | Observable success |
| --- | --- |
| Design proposal with an ownership defect | Brief includes real code and contestable reasoning; reviewer checks source and supports an objection or alternative with evidence. |
| Sound proposal | Reviewer may keep it; no invented redesign or repeated reviews to force disagreement. |
| Reviewer requests a benchmark | Codex receives a specific discriminating check; Claude does not execute it or create a laboratory. |
| Advice-only request | Codex returns the proposed check without silently authorizing implementation. |
| Follow-up with new evidence | Same native session recalls the question, revises its judgment, and retains read-only access. |
| Adversarial review without a reviewer restriction | Coordinator launches two fresh Codex reviews with different starting questions and the same evidence, withholding their findings from each other until both initial verdicts arrive. Claude is not invoked. |
| Ordinary final code check | Uses post-implementation-review locally; does not launch the reviewer pair. |
| Standalone request for Claude's opinion | Consults Claude without automatically launching a Codex reviewer. |
| Explicit Codex-only adversarial review | Honors the restriction and does not enlist Claude. |
| Reviewers agree without evidence of a shared blind spot | Coordinator verifies and reconciles findings; agreement alone does not trigger a third review. |
| Reviews share a consequential unsupported premise | Coordinator names the suspected assumption before commissioning any third review of that frame. |

For runtime acceptance, separately verify current uncommitted reads, context on
resume, denied outside reads, absent write/shell/agent/MCP tools, and unchanged
fixture files. Test hooks with an inert marker in a disposable fixture. Mocked
launcher tests prove argument forwarding, not CLI enforcement.

Count a consultation as useful when it improves the decision or its supporting
evidence. More objections, longer reports, and agreement between models are not
success metrics. A full skill-quality A/B remains distinct from the launcher's
runtime acceptance checks.
