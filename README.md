# url-state-contract-checker

Check route, query and fragment state against a declared URL contract:
schemas, defaults, multiplicity, unknown-key policy and serialization.

- **Repository:** [edilec/url-state-contract-checker](https://github.com/edilec/url-state-contract-checker)
- **Area:** Web & UX
- **License:** MIT
- **Dependencies:** none, at runtime or for development. Node built-ins only.

## The problem

A URL is a public API that almost nobody writes down. A filter panel adds
`?tag=a&tag=b`, an analytics link bolts on `utm_source`, someone bookmarks
`?page=007`, a mail client re-encodes a query, and every one of these paths
through the application has a different idea of what the link means. The
failures are quiet: a repeated key silently resolves to the last value, an
unknown key is dropped on the next navigation, a truncated percent escape turns
into U+FFFD and gets stored as a search term.

This tool makes the URL contract explicit and checks fixture URLs against it.
It declares which keys exist, what they hold, whether they may repeat, what
happens to keys nobody declared, and what a fragment is allowed to be. It then
proves the thing that actually breaks: that parsing a URL and serializing it
back gives you the same values.

## Install

```sh
git clone https://github.com/edilec/url-state-contract-checker.git
cd url-state-contract-checker
node --version   # v22 or newer
```

There is nothing to install. `npm install` is not required and adds nothing.

## Commands

| Command | What it does |
| --- | --- |
| `npm run lint` | `node --check` over every shipped source and test file |
| `npm test` | the full `node:test` suite |
| `npm run test:coverage` | the suite with coverage over `src/` |
| `npm run example` | checks the clean example fixture; exits 0 |
| `npm run pack:check` | `npm pack --dry-run` |
| `npm run check` | lint, test, example and pack check in one pass |

CLI:

```sh
node bin/url-state-contract-checker.mjs \
  --contract examples/contract.json \
  --urls examples/urls.clean.json

node bin/url-state-contract-checker.mjs \
  --contract examples/contract.json \
  --url '/catalog/tools/search?q=drill&utm_source=news' --json
```

| Option | Meaning |
| --- | --- |
| `--contract FILE` | the declared contract (required) |
| `--urls FILE` | fixture file: a JSON array of URLs, or `{ "urls": [ ... ] }` |
| `--url URL` | a single URL; repeatable, and combines with `--urls` |
| `--timeout-ms N` | wall budget across all URLs (default 10000) |
| `--json` | machine mode: suppress the human summary on stderr |
| `-h`, `--help` | usage |

## Inputs

The **contract** is one JSON object describing the route pattern, its
parameters, the query keys, the unknown-key and repeated-key policies, and the
fragment mode. Every field is documented in
[`docs/url-state-contract.md`](./docs/url-state-contract.md).

The **fixture** is a JSON array of URL strings, or an object with a `urls`
array whose entries are strings or `{ "id": "...", "url": "..." }` objects.
URLs may be absolute or root-relative; the origin is preserved and not checked.
It must hold at least one URL: an empty fixture is reported as `fixture-empty`
and exits `2`, so a CI job pointed at an empty or wrongly-populated list cannot
report green having checked nothing.

Both are read from local files. The tool never opens a network connection.

## Outputs

stdout carries the JSON report and nothing else, so it pipes straight into a
parser. The human summary and every usage diagnostic go to stderr.

```json
{
  "schemaVersion": "1",
  "tool": "url-state-contract-checker",
  "status": "fail",
  "summary": { "checked": 12, "errors": 14, "warnings": 0, "info": 32, "roundTrips": 0 },
  "findings": [
    {
      "ruleId": "repeated-single-key",
      "severity": "error",
      "message": "\"q\" is declared single but appears 2 times",
      "location": { "file": "examples/urls.broken.json", "pointer": "/urls/1/query/q" },
      "evidence": "q=drill&q=saw",
      "suggestion": "declare the key repeatable, or set repeatedSingleKeys to \"first\" or \"last\""
    }
  ]
}
```

`roundTrips` counts URLs for which `parse -> serialize -> parse` reproduced the
same values, both with declared defaults omitted and with them written out.
`location.file` names the input a finding belongs to: for a file that could not
be read or parsed, that is the file which actually failed, not the other input.

### Library

```js
import {
  normalizeContract, parseUrlState, serializeUrlState, checkUrls
} from 'url-state-contract-checker'

const contract = normalizeContract(JSON.parse(contractJson))
const { state, findings } = parseUrlState(contract, '/catalog/tools/search?q=torque+wrench')
state.query.page = 3
const url = serializeUrlState(contract, state)
// '/catalog/tools/search?q=torque%20wrench&page=3'
```

`parseUrlState` never throws on input: a URL it cannot use returns findings and
the most complete state it could recover. `serializeUrlState` throws
`UrlStateError` for a state it cannot represent, rather than emitting a lossy
replacement.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | every URL satisfied the contract (`status: "pass"`) |
| `1` | the contract was evaluated and at least one URL failed it (`status: "fail"`) |
| `2` | invalid usage or contract, unreadable input, or a limit or time budget was exceeded (`status: "incomplete"`) |

Evidence that could not be read is never reported as a pass. An unreadable
fixture exits `2`, not `0`, and so does a fixture that holds no URLs: `pass`
requires that at least one URL was checked and none failed.

A file that will not parse is named by position, line and column, never by
quoting it back — V8's own parse error embeds the document it choked on, so a
contract or fixture short enough to be only a credential would otherwise reach
both streams in full.

## Limits and non-goals

What this tool **cannot** conclude:

- **That your application honours the contract.** It checks URLs against a
  declaration you wrote. It does not read your router, your components or your
  state management, so a contract that disagrees with the code will still pass.
- **That a URL is safe.** It reports control characters and malformed encoding,
  but it does not decide whether a value is a safe redirect target, a valid
  identifier, or free of injection for whatever consumes it downstream.
- **That a link resolves.** Nothing is fetched. An origin is preserved verbatim
  and never validated, and a route that matches the pattern may still be a 404.
- **That serialization is byte-preserving.** It is value-preserving and
  canonical. `?q=a+b` re-serializes as `?q=a%20b` and `?page=007` as `?page=7`.
  If you need the original bytes back, keep the original string.
- **Anything about a URL it refused.** A URL past a declared limit, a fixture
  it could not read, and a fixture with nothing in it all make the whole report
  `incomplete`. That is the honest answer, not a partial pass.
- **That your fixture covers your application.** It checks the URLs you give
  it. A fixture that omits the link which actually breaks will still pass, so
  `summary.checked` is the number to watch in CI.
- **Fragment semantics.** `hash.mode: "opaque"` checks length and encoding
  only; it has no opinion about what the fragment means.
- **Encoding variants it does not implement.** There is no `;` pair separator,
  no bracketed array syntax (`tag[]=a`), no nested object encoding
  (`filter[colour]=red`), and no user-supplied regular expression. A contract
  cannot express those, so URLs using them will be reported as unknown or
  malformed rather than understood.

Determinism, the full rule catalog, the declared limits and the reasons
`URLSearchParams` is not used are documented in
[`docs/url-state-contract.md`](./docs/url-state-contract.md).

## License

MIT. See [LICENSE](./LICENSE).
