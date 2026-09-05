# Maintaining the Chinese documentation

Chinese documentation should help a reader understand a concrete operation, the
authority behind it, and what to do next. Explain the mechanism in connected
paragraphs; use procedures for steps and tables for information readers need to
compare or look up.

## Start from current behavior

Use implementation and relevant tests to resolve contradictions in prose. Check
`docs/KNOWN-LIMITATIONS.md` before describing a feature as available. Keep shipped
behavior, optional owner configuration, and future design work distinct. A design
document can explain an intended direction without establishing that it shipped.

For authorization, name the object and condition precisely. Exposure, an agent's
selected subset, a standing grant, a session, and a scoped token each answer a
different question. State defaults as defaults and preserve the owner's available
exceptions. A statement about revoking one grant must not imply that every agent
or credential has been revoked.

Comparisons with other protocols should describe concrete responsibilities and
check the current specification. Avoid turning a product distinction into a claim
that another protocol has no identity, authorization, or security model.

## Organize around the reader's task

Introduce a term through the problem it solves, then explain its place in the
flow. Each paragraph should develop one useful point: establish a condition,
explain an operation, show its consequence, or connect to the next step. Preserve
enough detail to make reference pages usable; an endpoint reference should not
become a short product overview.

Keep English protocol identifiers, commands, paths, and UI labels recognizable.
Define a Chinese term once where useful, then use it consistently. Prefer direct
verbs and concrete objects over repeated slogans, rhetorical questions, and
metaphors that obscure who can do what. End an explanation when its consequence
is clear, or point to the relevant next operation.

Short interface labels have different constraints from explanatory prose. Keep
navigation labels easy to scan and keep prompts actionable. A demo caption must
describe the simulated event it accompanies without promising broader runtime
behavior.

## Preserve the document's functionality

When a Chinese heading changes, retain the existing VitePress anchor with an
explicit heading ID. GitHub Markdown uses HTML anchors instead. Check links from
other pages as well as links within the edited page.

Preserve executable commands, request and response examples, protocol field
names, Vue components, and interpolation expressions. Change an example only
when its behavior needs correction, and explain that correction in review.
Homepage copy, page metadata, navigation, and simulated demo text are part of
the same documentation surface.

Before opening a documentation PR, run the repository's canonical `bun run gate`
and the production website build with `bun run --cwd site build`. Review the
rendered pages when changing headings, tables, component copy, or homepage text.
Include factual corrections and any remaining limitations in the PR description.
