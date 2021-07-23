# Changelog

All notable changes to this project are documented here. The project uses
[Semantic Versioning](https://semver.org/).

Rule identifiers are part of the public contract. Renaming or removing one is a
breaking change and is recorded here.

## Unreleased

### Added

- URL state contract format: route pattern with typed parameters, query and
  fragment descriptors, `single` and `repeatable` multiplicity, declared
  defaults, and `string`, `integer`, `boolean` and `enum` value types with
  range, length and charset bounds.
- Configurable unknown-key policy (`error`, `warn`, `keep`, `drop`) for the
  query and for fragment parameters, and a repeated-single-key policy
  (`error`, `first`, `last`).
- `parseUrlState` and `serializeUrlState`, with a strict percent codec that
  reports malformed escapes and invalid UTF-8 instead of repairing them to
  U+FFFD, and canonical serialization over the RFC 3986 unreserved set.
- `checkUrls`, which verifies the `parse -> serialize -> parse` round trip for
  every URL in both the default-omitting and the default-including form, and
  emits a report-contract v1 envelope.
- CLI with `--contract`, `--urls`, `--url`, `--timeout-ms`, `--json` and
  `--help`. The JSON report goes to stdout alone; diagnostics go to stderr.
- Thirty-one stable rule identifiers, documented in
  `docs/url-state-contract.md`.
- Declared byte, entry, key, value, depth and time limits. Exceeding one is a
  named finding and an `incomplete` report, never a silent truncation.
- Clean and deliberately broken example fixtures, and tests covering the public
  API and the real CLI entry point.

### Fixed

- A fixture holding no URLs no longer reports `pass` with `checked: 0` and exit
  `0`. Both `[]` and `{ "urls": [] }` now emit the new `fixture-empty` rule and
  an `incomplete` report with exit `2`, so a run that checked nothing cannot be
  mistaken for a green one.
- A contract that could not be read or parsed is now attributed to the contract
  file in `location.file`. It previously named the `--urls` fixture, or the
  literal `inline`, pointing consumers that group findings by file at a
  perfectly healthy input.

No release has been published.
