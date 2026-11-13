# 0886. Vocab practises with a tutor on the person's own model, and Zhongwen is Vocab cloned for Chinese

- **Status:** Accepted
- **Date:** 2026-11-12
- **Relates:** [ADR-0866](0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md) (a starter kept as `upstream`), [ADR-0885](0885-an-epicenters-apps-live-in-apps-which-its-repository-ignores-with-one-line.md) (apps live in `apps/`), [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (an app's two repositories), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (`.local` files), [ADR-0883](0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md) (`serve` runs on the host).

## Context

On the owner's Studio, on 2026-11-12, `~/Epicenter/Zhongwen/` was the data of
an older app, `~/Code/zhongwen`: six saved expressions, four practice
conversations with a tutor, one recording, and a `showPinyin` setting. That
app's code is mostly what Epicenter replaces: storage adapters for the browser
and Tauri, GitHub sync, hosted sign-in, a demo gateway, and a release
installer. What it did that no Epicenter app does is practice: a conversation
with a tutor about expressions the learner chose, and feedback when it ends.
Its tutor was Ollama's `qwen3.5:9b` on the learner's own computer.

`apps/vocab` already holds words with the same `stage` values Zhongwen's
expressions had, plus reviews. It has no words yet.

## Decision

**Vocab gains practice with a tutor that runs on a model the person serves
themselves. Zhongwen is a clone of Vocab, made with `epicenter new zhongwen
--from <Vocab's origin>`, which adds pinyin and a tutor for Chinese and keeps
Vocab as its `upstream`.** The upstream is Vocab's origin URL, not the path
`apps/vocab`, so an Epicenter rebuilt on another computer still merges from it.

```txt
apps/vocab/                    gains practice; any language
  data/words/<word>.md
  data/conversations/<time>.md
  data/settings.md             endpoint, model
apps/zhongwen/                 Vocab's code, upstream = Vocab
  data/words/超市.md            the six old expressions
  data/conversations/<time>.md the four old conversations
  data/recordings/<time>.webm  the old recording, kept; no audio feature
  data/settings.md             endpoint, model, showPinyin
```

- **The tutor runs on the person's own model.** Actions call an
  OpenAI-compatible chat endpoint named in `data/settings.md`, by default
  `http://127.0.0.1:11434/v1` and `qwen3.5:9b`: Ollama on the computer that
  runs `serve`. A call from a phone runs there too, so the conversation
  reaches no other service. Changing the model is an edit to that file. The
  person's agent can call every action, but it is not the tutor.
- **Practice is three actions and a page.** `practice start` asks the model
  to open and makes the conversation with its first turn. `practice reply`
  takes a conversation and the learner's message, asks the model, and saves
  both turns once the reply is complete; when the model fails, it saves the
  learner's turn alone, so a message is never lost. `practice finish` asks the
  model for feedback on how the learner used the chosen words and saves it in
  the conversation. The Practice page chooses words, shows the conversation,
  and finishes it. The first version waits for whole replies.
- **No action writes before its model call.** A call holds the app's lock
  from its first write until it ends, and another writer waits at most 30
  seconds; a write before a reply that takes 40 would turn a review from the
  phone into "busy".
- **A conversation is one Markdown file.** Its front matter holds when it
  started, the words chosen (by their names in `data/words/`), and when it
  finished. Its body holds one `## Learner` or `## Tutor` section per turn, in
  order, then `## Feedback`. A person or an agent can read and edit it by
  hand.
- **Zhongwen differs from Vocab only where Chinese needs it.** Its tutor's
  instructions are for Chinese: corrections explained in English, one question
  in Chinese. Its pages show pinyin, worked out from the characters as they
  are shown and never stored, behind a toggle in the header. The toggle is
  `showPinyin` in `data/settings.md`, so it is the same on every device.
- **Duplicated code is accepted.** `epicenter update zhongwen` merges Vocab's
  changes; a conflict is resolved once where Zhongwen changed the same lines.
- **The old app is not ported.** Its data moves into `apps/zhongwen/data/`,
  expressions renamed by their text; `~/Epicenter/Zhongwen/` is then removed,
  and stays in the Epicenter repository's history. `~/Code/zhongwen` and its
  repository are left as they are.

## Consequences

- Practice depends on a model server running beside `serve`. When it is not
  reachable, `practice reply` fails, naming the endpoint, and saves the
  learner's message so it is not lost.
- A 9B local model is a weaker tutor than a hosted one; a bigger local model
  is a settings edit away.
- Flipping the pinyin toggle commits to Zhongwen's data history.
- Each tutor turn is a data commit, so `epicenter undo zhongwen` takes back a
  turn.

## Considered alternatives

- **One app, Vocab, with Chinese features behind a setting.** Every language's
  quirks would land in one UI. A clone keeps each app plain.
- **The person's agent as the tutor.** Stronger, and nothing to build, but it
  leaves the app's page and sends the practice to a hosted model.
- **Port `~/Code/zhongwen`.** Most of its code solves storage and sync that
  Epicenter already does.
- **Pinyin stored per word.** It is derived from the characters; storing it
  invites the two to disagree.
