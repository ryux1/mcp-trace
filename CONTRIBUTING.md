# Contributing

Thank you for helping improve MCP Trace.

## Before opening a change

- Search existing issues and pull requests.
- For behavior changes or new dependencies, open an issue first.
- Keep pull requests focused on one problem.
- Never include real credentials, production recordings, or user data in issues, fixtures, or
  commits.

Security vulnerabilities belong in the private process described by [`SECURITY.md`](SECURITY.md),
not a public issue.

## Development

Requirements: Node.js 20.19 or newer and pnpm 11.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

Useful focused commands:

```bash
pnpm test
pnpm test:coverage
pnpm check
pnpm lint
pnpm format
pnpm benchmark
```

## Pull requests

A pull request should include:

- the user-visible problem and why it matters;
- the smallest implementation that addresses it;
- tests that fail without the implementation change;
- security/privacy impact, especially for recording, headers, replay, and network exposure;
- documentation updates for public behavior.

Run `pnpm verify` before requesting review. Avoid force-pushing after review begins when a normal
follow-up commit will preserve useful context.

## AI-assisted development

AI tools are welcome when a contributor understands and owns the result. Disclose substantial AI
assistance in the pull-request description. Review every line, keep public communication concise,
and be prepared to explain and revise the implementation. Bulk, queue-driven, or unreviewed agent
submissions are not accepted.

## Design principles

- Preserve transport semantics and streaming behavior.
- Keep the upstream fixed and the proxy boundary narrow.
- Default to metadata-only observation and localhost-only access.
- Fail closed when a security choice is ambiguous.
- Treat unavailable verification as a limitation, never as a pass.
- Keep metric labels bounded and recordings schema-versioned.

By participating, you agree to follow the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
