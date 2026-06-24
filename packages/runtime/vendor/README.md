# Vendored third-party assets (embedded in the Plexus distribution)

## cc-master-plugin/
The cc-master Claude Code plugin, **embedded** so Plexus can launch a managed
`claude --plugin-dir <this>` session WITHOUT touching the user's `~/.claude`
(the "intervene in a first-party app" capability — see AUTHZ/expose domain model).

- Source:  https://github.com/nemori-ai/cc-master
- Version: **v0.9.1**
- Commit:  85fedda5f312f6bd86efb376f4eec820c5a03c44
- Vendored: 2026-06-24
- Pruned:  .git, tests/, design_docs/, adrs/, docs/, examples/, .github/
           (functional parts kept: .claude-plugin/ commands/ skills/ hooks/ scripts/)

To refresh: re-clone the tag, re-apply the same prune list, bump the version/sha above.
This directory is NOT typechecked or test-discovered — keep it out of tsconfig `include`.
