# Consultation example and evaluation

This is a hypothetical interaction, not a claim about Epicenter's current APIs
or a transcript of executed tests. The named example files belong to a fictional
fixture. A real brief includes excerpts and paths from the actual checkout.

This is a standalone Claude consultation, so the proposal appears in the first
brief. An explicitly blind review withholds the proposal for its initial pass; adversarial-review owns that choice.

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
commands, changes, deciding evidence, quality of the result, and unmet checks. The scripted conversation
above illustrates the target; it is not a measured result or an answer key.

| Case | Observable success |
| --- | --- |
| Design proposal with an ownership defect | Brief includes real code and contestable reasoning; reviewer checks source and supports an objection or alternative with evidence. |
| Sound proposal | Reviewer may keep it; no invented redesign or repeated reviews to force disagreement. |
| Reviewer requests a benchmark | Codex receives a specific discriminating check; Claude does not execute it or create a laboratory. |
| Advice-only request | Codex returns the proposed check without silently authorizing implementation. |
| Follow-up with new evidence | Existing task notes preserve the native session locator, account, checkout, model and effort. The same native session recalls the assignment; capability and source changes are stated explicitly. An older Sonnet session can continue as Opus without a new conversation. |
| Claude-owned evidence gathering | With explicit host-provided Codex assistance, Claude asks a bounded source question, inspects deciding sources, and returns its own judgment. The consultation cannot request implementation. |
| Claude-owned delivery with Codex implementation | In the current checkout or an explicitly selected standalone clone, Claude briefs, inspects and corrects Codex work. Only the Codex helper has code-writing tools; the coordinating Codex pauses its edits and performs focused acceptance. Current-checkout delivery needs no copy step; only a clone delivery requires transferring accepted changes. |
| Named personal/work subscription | Native preflight verifies the selected profile and expected Claude email; conflicting API/provider overrides cannot send the brief under another billing method. Claude resolves resumes in the selected profile and rejects missing sessions; the launcher does not inspect transcript layout. |
| Adversarial design review without a reviewer restriction | Coordinator uses the reviewer setup defined by adversarial-review. This example does not choose reviewer models or duplicate that workflow. |
| Ordinary final code check | Uses post-implementation-review locally; does not launch the reviewer pair. |
| Bounded read-only caller map or documentation draft | Claude returns the finished artifact with source evidence; Codex checks decisive claims without launching a panel. |
| Explicit implementation or benchmark delegation | Uses delegate-claude in the current checkout by default; Claude applies changes and runs checks; Codex inspects the diff and reproduces deciding checks without repeating the investigation. |
| Delegation target inside or containing the checkout, an external linked worktree, or consultation with `--workspace` | The launcher refuses before sending the brief. |
| Helper-backed skill edit | The coordinator selects `--codex-write-root` for each assigned skill directory on every turn; consultation, direct delegation, paths outside `.agents/skills` and symlink escapes are refused before launch. |
| Standalone request for Claude's opinion | Consults Claude without automatically launching a Codex reviewer. |
| Explicit Codex-only adversarial review | Honors the restriction and does not enlist Claude. |
| Reviewers agree without evidence of a shared blind spot | Coordinator verifies and reconciles findings; agreement alone does not trigger a third review. |
| Opportunity for a different organizing idea without a known defect | Coordinator can commission a fresh exploration, names what it could improve, and compares concrete use, guarantees, deletion prizes, and introduced complexity. |
| Reviews share a consequential unsupported premise | Coordinator commissions a focused challenge or fresh exploration and verifies the deciding claims; it can challenge its own synthesis. |
| Reviewer drifts into local cleanup | Coordinator redirects a completed-turn follow-up toward the ownership, lifetime, representation, or interaction that makes the machinery necessary, without prescribing a verdict. |
| New evidence changes an execution assignment | Delegate-claude sends a fresh brief in the same idle clone with the full assignment, changed evidence, and acceptance criteria, retains useful partial work, and keeps one writer per clone. |

For runtime acceptance, separately verify current uncommitted reads, context on
resume, denied outside reads, absent write/shell/agent/MCP tools, and unchanged
fixture files. Test hooks with an inert marker in a disposable fixture. Mocked
launcher tests prove argument forwarding, not CLI enforcement.

Count a consultation as useful when it improves the decision or its supporting
evidence. More objections, longer reports, and agreement between models are not
success metrics. A full skill-quality A/B remains distinct from the launcher's
runtime acceptance checks.

## Runtime acceptance: 2026-10-20

Actual local runs used Claude Code 2.1.302 and Codex CLI 0.154.0, with native
Claude Max and ChatGPT logins. Claude's native usage identified Sonnet 5.5 at
medium effort; the Codex helper was explicitly requested as GPT-6.1 Sol at
medium effort. Tests used a disposable three-file Git fixture and its standalone
clone outside the repository, with no dependencies to install in the fixture.
Those runs predate current-checkout delivery, when a standalone clone was the
only accepted delegation workspace.
Those live runs explicitly selected Claude medium effort; the current launch
default is high, checked separately for new and resumed launches.

- A consultation invoked the evidence tool, received a source-linked caller
  map, read the decisive files itself, and returned the fixture's marker. The
  source checkout remained clean. This took about 35 seconds with no permission
  denials.
- A delegation invoked the implementation tool to fix subtraction in an `add`
  function, inspected the result, and returned the helper's passing test. The
  coordinator reproduced the test: one pass, zero failures, two assertions.
  Only the clone's `math.ts` changed; its marker and the source checkout were
  unchanged. This took about 33 seconds with no permission denials or correction
  rounds. Acceptance included direct diff inspection and a reproduced check.
- The same Claude session remembered an acceptance label after a parent resume
  and used a fresh helper connection. A separate native helper resume retained
  its prior file observation and test result under the same helper session ID.
- A native configuration check exposed table merging: `mcp_servers={}` did not
  clear inherited servers. Explicit per-server overrides disabled all eight
  discovered servers. Native implementation and helper-resume runs then passed
  with those overrides.

These runs establish transport and observed behavior on a small fixture. They
do not establish a usage saving or quality improvement on real architecture or
implementation assignments. Timeout, cancellation, overlap, call limits,
foreign-session refusal, malformed results and attempted access widening are
covered separately by mocked-process tests; those tests do not prove OS
enforcement. The coordinator spent additional time building and checking this
capability, so these timings are not a delegation-efficiency comparison.

A subsequent main-checkout delivery used Opus 5.5 high and two GPT-6.1 Sol
medium implementation helpers for the skill guidance and tests. Claude directed
and inspected both results in the main checkout. The final turn took about six
minutes and reported 27 passing tests; this was not a speed comparison. Two
earlier turns in the same native Claude conversation reported concrete blockers:
protected `.agents` writes, then a malformed scoped permission profile. The
coordinator corrected the launcher and returned the evidence to that same chat.
An exact-argument native sandbox probe then confirmed that only the selected
skill subtrees reopened inside `.agents`; sibling subtrees and `.git`/`.codex`
stayed read-only. A TOML regression test now covers the malformed-profile failure.
A separate live resume of an older Sonnet chat under the Opus high default
retained both prior acceptance labels without tools.
