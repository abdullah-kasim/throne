# Pinned ripgrep and fd

`install.sh` runs `scripts/install-search-tools.sh`, which downloads the
`tools.ripgrep` and `tools.fd` archives pinned in `vendor-pins.json` for this
host's platform, refuses one whose sha256 differs from the pin, and unpacks the
binaries to `vendor/bin/rg` and `vendor/bin/fd`. Downloads are cached under
`${XDG_CACHE_HOME:-~/.cache}/throne/search-tools/`. A re-run with the pinned
versions already in `vendor/bin` does nothing. A failed download or an
unpinned platform prints a warning and the install goes on.

`bin/rg` and `bin/fd` (a link to `bin/rg`) run the vendored binary. When it
is missing they run the next `rg` or `fd` on PATH, skipping their own
folder, and exit 127 only when there is none. `bin/` is first on every
agent's PATH, so pi finds them and never downloads its own copies, and
`throne locate` finds a real `rg`.

Where each pinned sha256 came from (ripgrep 15.2.0 and fd v10.5.2, checked
2026-11-18): each archive named below was read from the release's asset list
(<https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0>,
<https://github.com/sharkdp/fd/releases/tag/v10.5.2>), downloaded from the
release's download URL and hashed with `sha256sum`. Each ripgrep hash also
matched the release's published `<archive>.sha256` file; fd publishes no
checksum files. Linux uses the musl builds on both machines.

- `ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz` (ripgrep linux-amd64): `33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c`
- `ripgrep-15.2.0-aarch64-unknown-linux-musl.tar.gz` (ripgrep linux-arm64): `800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915`
- `ripgrep-15.2.0-x86_64-apple-darwin.tar.gz` (ripgrep darwin-amd64): `af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1`
- `ripgrep-15.2.0-aarch64-apple-darwin.tar.gz` (ripgrep darwin-arm64): `3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4`
- `fd-v10.5.2-x86_64-unknown-linux-musl.tar.gz` (fd linux-amd64): `7e2d07fa2b8807642aaec67b7e2972a9fbe4db26fcb340a7372392db42b26694`
- `fd-v10.5.2-aarch64-unknown-linux-musl.tar.gz` (fd linux-arm64): `63ea52cb31586e6d98efa2f06d73d542f16c7d0c4af0f07b579aaf9714cf907a`
- `fd-v10.5.2-x86_64-apple-darwin.tar.gz` (fd darwin-amd64): `0f02e6000a8c896cd254cf4dccc7da1e604e77a32c6783609eed5e4cb07785e3`
- `fd-v10.5.2-aarch64-apple-darwin.tar.gz` (fd darwin-arm64): `81bf98a16d3d7230e4a9123fcede243d71ea31a577113476ed43f1cdf4773162`

To move a pin, read the new release's asset list, repeat the download and hash
for all four platforms, and replace the version, `releaseUrl`, archive names
and sha256 values together.
