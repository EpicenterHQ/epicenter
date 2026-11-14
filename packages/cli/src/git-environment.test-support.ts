/**
 * Preloaded before every test (`bunfig.toml`), so a test never depends on
 * the machine's own Git configuration, which a CI runner lacks: commits are
 * made as a test identity, and a new repository's first branch is `main`.
 * In-process runs read `process.env`, and every spawned `git` or
 * `epicenter` inherits it.
 */
process.env.GIT_AUTHOR_NAME = 'Epicenter Test';
process.env.GIT_AUTHOR_EMAIL = 'epicenter-test@example.com';
process.env.GIT_COMMITTER_NAME = 'Epicenter Test';
process.env.GIT_COMMITTER_EMAIL = 'epicenter-test@example.com';
process.env.GIT_CONFIG_COUNT = '1';
process.env.GIT_CONFIG_KEY_0 = 'init.defaultBranch';
process.env.GIT_CONFIG_VALUE_0 = 'main';
