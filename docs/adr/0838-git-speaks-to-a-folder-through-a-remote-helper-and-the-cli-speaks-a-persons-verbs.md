# 0838. Git speaks to a folder through a remote helper, and the CLI speaks a person's verbs

- **Status:** Superseded
- **Date:** 2026-11-07
- **Superseded by:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md), the same day: Epicenter became the home of one person's apps and agents, and the folder sync product this record belongs to waits. Read it as that product's design.
- **Amends:** [ADR-0834](0834-every-folder-is-also-a-git-remote.md) at a folder's Git remote served by the server: Git reaches a folder through `git-remote-epicenter`, a remote helper on the computer, and a remote on the server waits for a sandbox that has Git and nothing else; [ADR-0826](0826-history-enters-and-leaves-epicenter-as-git.md) at `epicenter export --git` and `import --git`: history leaves by `git clone` and enters by `git push`; [ADR-0831](0831-a-git-branch-lands-in-a-folder-as-one-change-through-the-cli.md) at `epicenter git land`: a push lands; [ADR-0827](0827-the-cli-and-mcp-render-one-table-of-operations.md) at the CLI's commands: the table holds a person's verbs.
- **Relates:** [ADR-0837](0837-the-ledger-is-the-persons-model-folders-the-versions-of-their-files-and-who-may-see-them.md) (the ledger is the person's model), [ADR-0835](0835-records-from-0802-to-0834-agree-on-files-a-ledger-and-git-at-the-edges.md) (the register).
- **Amended by:** [ADR-0839](0839-a-save-is-one-numbered-write-a-reset-deletes-nothing-and-epicenter-owns-the-pages-every-app-links-to.md) at a push landing merged and at the commands: a push lands only when made from the latest version, and `get` covers invitations.
- **Unbuilt:** all of it: `git-remote-epicenter`, shipped with the CLI; the commands below; removing `export`, `import`, `land`, `init`, `clone`, `status`, `log`, `diff`, and `at` from the table.

## Context

History left and entered through three commands of Epicenter's own, `export
--git`, `import --git`, and `git land`, and a remote on the server was planned so
that Git itself could clone and push, which would put Git's transfer protocol
and a Git view of every folder back on the server. Git has a standard way to
reach a store it does not know: a remote helper, a program named
`git-remote-<name>` that Git runs for an address `<name>::<address>`, speaking
Git's fast-import and fast-export streams. The export already writes a
fast-import stream, and landing a branch already translates commits into
versions. A person's commands mixed their own verbs with the platform's.

## Decision

**Git reaches a folder through `git-remote-epicenter`**, which ships with the
CLI and uses its sign-in:

```sh
git clone epicenter::Recipes      # the folder's whole history, as a Git repository
git push                          # lands as versions, merged, or refused like "fetch first"
git remote add epicenter epicenter::vault && git push epicenter main   # a repository in
```

A fetch writes the folder's versions as commits; a push translates its commits
into versions expecting what the folder held where the push began, refused on a
true conflict or a rewrite. The server speaks no Git. A remote on the server
waits for a sandbox that has Git and cannot run the helper.

**The CLI speaks a person's verbs**, naming folders by their names in
`~/Epicenter`:

| Command | Does |
| --- | --- |
| `epicenter` | every folder and its mark |
| `epicenter new <name>` | makes a folder |
| `epicenter get <folder>` | brings a folder you hold onto this computer |
| `epicenter share <folder> <email> [--reader]`, `unshare` | shares, and stops |
| `epicenter invites` | what has been shared with you, to accept |
| `epicenter history <path>` | every version, with who and when |
| `epicenter show <path> [--at <when>]` | a version |
| `epicenter restore <path> [--at <when>]` | brings a version back as a new one |
| `epicenter sync [<folder>]` | now, instead of within thirty seconds |
| `epicenter mcp [--all]` | tools for an agent |

**A person's verbs are edit, share, go back, and take.** Saving and syncing are
the platform's, and a person meets them only as the marks.

## Consequences

- Taking a folder's history is `git clone`; bringing a repository in is
  `git push`.
- The server has no Git code.
- A machine without the CLI reaches a folder through Git only once the server's
  remote exists.
