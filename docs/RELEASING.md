# Releasing TermKode

TermKode releases are standalone CLI binaries published through GitHub Releases.
Each binary is self-contained: it embeds no credentials, contacts no TermKode
service, and uses the API key supplied by the person running it.

## One-time repository configuration

1. Protect `main` and require the `CI / validate` check.
2. Create the `termkode/homebrew-tap` public repository with a `Formula`
   directory and a protected `main` branch.
3. Add this Actions variable to the TermKode repository:
   - `HOMEBREW_TAP_REPOSITORY=termkode/homebrew-tap`
4. Add `HOMEBREW_TAP_TOKEN` as an Actions secret. Use a fine-grained token or
   GitHub App token restricted to the tap repository with Contents and Pull
   requests write access.

Do not place provider API keys or any other credential in GitHub variables used
by the binary build.

## Creating a release

1. Merge the release changes into `main`.
2. Update `packages/cli/package.json` to the intended semantic version.
3. Run the CI workflow successfully on `main`.
4. Create and push a matching tag:

   ```sh
   git tag -a v0.1.0 -m "TermKode v0.1.0"
   git push origin v0.1.0
   ```

The tag must match the CLI version. Tags with a prerelease suffix, such as
`v0.1.0-beta.1`, are published as GitHub prereleases.

The release workflow validates the project, builds eight platform targets,
creates archives and checksums, generates GitHub provenance attestations, and
publishes the GitHub Release. If Homebrew is configured, it then tests the new
formula and opens an update PR in the tap repository.

## Verifying release assets

```sh
gh release download v0.1.0
shasum -a 256 -c SHA256SUMS
gh attestation verify termkode-v0.1.0-darwin-arm64.tar.gz \
  --repo vishvajeet2012/Termcode
```

Before promoting the first stable release, test the TUI, chat with a provider
key, local tools, and NeoLens on clean macOS, Linux, and Windows machines.
Alpine/musl verification installs the required `libstdc++` and `libgcc` runtime
packages before launching the binary.

## Homebrew

Users install the formula directly from the tap:

```sh
brew install termkode/tap/termkode
```

After the automated formula PR is reviewed and merged, `brew update` and
`brew upgrade termkode` deliver the new version.

## Code signing

GitHub checksums and attestations are enabled by default. Apple Developer ID
signing/notarization and Windows Authenticode signing require organization-owned
certificates and may be added later without changing the release format. Until
then, document that macOS may require approval in Privacy & Security and Windows
may display a Microsoft Defender SmartScreen warning. Verify downloads against
`SHA256SUMS` or their GitHub attestations before overriding an operating-system
warning.
