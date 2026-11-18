# Writing inbox

Save thoughts, quotes, and links. Find them when you sit down to write.
The browser, terminal, and your agent use the same actions and Markdown files.
No AI account or external service is needed.

Use the latest Epicenter CLI.
To add Writing to your home, run these at the top of the home

```sh
mkdir -p apps/writing/code
curl -L https://github.com/EpicenterHQ/epicenter/archive/main.tar.gz | tar -xz -C apps/writing/code --strip-components=3 epicenter-main/examples/writing
bun install && bun run build
epicenter serve
```

Open `http://localhost:4747/apps/writing/`. Downloading the app requires network
access. Using the copied app needs neither GitHub nor a provider key.

Open the app at `/apps/<app>/` while `epicenter serve` runs. Capture text, an optional
source (a person, book, or URL), and an optional project. Search matches the text,
source, and project. A damaged note shows its file problem alongside matches.
A note with unreadable front matter appears in every search until repaired. Open a note to edit its text. Saving quotes the original
text; if it no longer matches, your draft stays in the editor so you can compare
it with the saved file.
Unsubmitted text is held only in the current page; keep the page open until saved.

For an app named writing:

```sh
epicenter writing add '{"body":"A small observation worth returning to"}'
epicenter writing add '{"body":"A quote from my reading","kind":"quote","source":"Book, page 42","project":"My essay"}'
epicenter writing search '{"query":"reading"}'
epicenter writing search '{"project":"My essay"}'
```

Use a returned id with `epicenter writing get '{"id":"ID"}'` to read one
note. `epicenter writing add --help` lists the keys an action takes.
The CLI lists every action with `epicenter writing`. `patch` changes fields,
and `edit` with `{ id, old, new }` replaces one exact passage in the body. The
UI changes only the body, through `edit`.
MCP offers the same actions at the server root. Start by asking an assistant
to find relevant notes, with their sources, before drafting anything new.

## Make it yours

Records live in sibling `data/notes/`. This `code/` folder is yours to change.
Ask your coding agent: "Add an optional topic field to the notes, show it on the
capture form, and include it in search. Keep existing notes readable."

`epicenter.ts` declares the fields and actions. `ui/main.ts` calls them through
`@epicenter/app/client`; `ui/index.html` and `ui/style.css` define the interface.
The next action call loads your changed code. After changing `ui/`, run
`bun run build` in `code/` and reload the page.

This app has no third-party app dependencies. `@epicenter/app` comes from
your Epicenter's own `package.json`. To add your own dependencies, run
`bun add` in this code folder, then restart `epicenter serve`. Changes in a shared copy
do not replace your changes.

History belongs to the Epicenter's private root repository. Make a named commit
before experimenting, and experiment outside the live folder. `git commit
-am 'Adapt my writing inbox'` records pending code and records together.
Keep the repository private: it contains your writing.

## Take changes from another copy

Copying a folder makes a new app. To update this app, ask your agent to copy
the incoming code into a temporary folder outside your live Epicenter, compare
it with your `code/`, and reconcile it with your edits. Apply the reviewed
changes only to `code/`, test them with your existing notes, and inspect any
record problems before making a named commit. Keep `data/`.

There is no automatic updater.
