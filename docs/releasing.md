# Releasing

This procedure keeps the npm package, container image, GitHub release, changelog, and repository
metadata aligned. A release is complete only when every published surface points to the same tagged
commit.

## One-time repository configuration

1. Set the GitHub repository description to:

   > Security-first Model Context Protocol observability gateway for Streamable HTTP recording,
   > inspection, tracing, and replay.

2. Set the website to `https://ryux1.github.io/mcp-trace/` and add these topics: `developer-tools`,
   `mcp`, `mcp-observability`, `mcp-proxy`, `model-context-protocol`, `opentelemetry`, `prometheus`,
   `record-replay`, `streamable-http`, and `typescript`.
3. In **Settings → Pages**, select **GitHub Actions** as the source. The `Pages` workflow publishes
   the static files in `docs/`.
4. In **Settings → General → Social preview**, upload `docs/assets/social-preview.png`.
5. Create a protected GitHub environment named `npm`. Do not add secrets after trusted publishing is
   configured.

The description, website, and topics can be applied after authenticating the GitHub CLI:

```bash
gh repo edit ryux1/mcp-trace \
  --description "Security-first Model Context Protocol observability gateway for Streamable HTTP recording, inspection, tracing, and replay." \
  --homepage "https://ryux1.github.io/mcp-trace/" \
  --add-topic developer-tools \
  --add-topic mcp \
  --add-topic mcp-observability \
  --add-topic mcp-proxy \
  --add-topic model-context-protocol \
  --add-topic opentelemetry \
  --add-topic prometheus \
  --add-topic record-replay \
  --add-topic streamable-http \
  --add-topic typescript
```

## First npm publication

npm requires a package to exist before its trusted publisher can be configured. For the first
release only, authenticate locally with an npm account authorized to publish the `@ryux1` scope,
verify the exact release commit, and bootstrap the package:

```bash
npm login
npm whoami
pnpm install --frozen-lockfile
pnpm verify
pnpm smoke:package
NPM_CONFIG_PROVENANCE=false npm publish --access public
```

Then configure the trusted publisher with npm 11 or newer:

```bash
npm trust github @ryux1/mcp-trace \
  --file release.yml \
  --repo ryux1/mcp-trace \
  --env npm \
  --allow-publish \
  --yes
npm trust list @ryux1/mcp-trace
```

The equivalent package settings are:

- GitHub owner: `ryux1`
- repository: `mcp-trace`
- workflow filename: `release.yml`
- environment: `npm`

The first manual publication will not have GitHub Actions provenance. Subsequent versions are
published by OpenID Connect with provenance and no long-lived npm token. The workflow detects an
already-published version, so the bootstrap version can still receive its container image and GitHub
release when the tag is pushed.

## Release checklist

1. Update `package.json`, `src/version.ts`, and `CHANGELOG.md` to the same version and date.
2. Run the local gates:

   ```bash
   pnpm install --frozen-lockfile
   pnpm verify
   pnpm smoke:package
   pnpm demo
   git diff --check
   ```

3. Merge the reviewed release commit and wait for CI, CodeQL, package-consumer checks on Linux,
   macOS, and Windows, and the container build to pass.
4. Create one annotated tag at the verified main commit and push it:

   ```bash
   git tag -a v0.2.0 -m "MCP Trace 0.2.0"
   git push origin v0.2.0
   ```

5. Confirm that the release workflow published, from that tag:

   - `@ryux1/mcp-trace` on npm;
   - `ghcr.io/ryux1/mcp-trace:v0.2.0` and `latest` for `linux/amd64` and `linux/arm64`;
   - the GitHub release tarball and `SHA256SUMS.txt`.

6. Run the README `npx` command in a clean temporary directory, pull the versioned container, and
   confirm the Pages URL and social preview. Do not announce a release with a broken install path.

Never move or reuse a published version tag. If a publication is incomplete, fix the workflow and
rerun the same tag workflow only where the registries permit an idempotent retry.
