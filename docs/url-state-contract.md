# URL state contract format, rules and guarantees

This document is the reference for the contract file, the stable rule
identifiers, the declared limits, and the determinism guarantee.

## Contract file

A contract is a single JSON object.

```json
{
  "name": "catalog-search",
  "route": "/catalog/:category/search",
  "params": {
    "category": { "type": "enum", "values": ["cable", "fasteners", "tools"] }
  },
  "query": {
    "q":       { "type": "string",  "required": true, "maxLength": 120 },
    "tag":     { "type": "string",  "multiplicity": "repeatable", "maxCount": 4, "charset": "slug" },
    "page":    { "type": "integer", "default": "1", "min": 1, "max": 500 },
    "sort":    { "type": "enum",    "values": ["newest", "price", "relevance"], "default": "relevance" },
    "inStock": { "type": "boolean", "default": "false" }
  },
  "unknownQueryKeys": "error",
  "repeatedSingleKeys": "error",
  "hash": {
    "mode": "params",
    "params": { "panel": { "type": "enum", "values": ["compare", "filters"] } },
    "unknownKeys": "warn"
  }
}
```

### Top-level fields

| Field | Meaning |
| --- | --- |
| `name` | Label only. Does not affect checking. |
| `route` | Path pattern starting with `/`. A segment written `:name` is a parameter. Omit it to leave the path unchecked. |
| `params` | Descriptors for route parameters. Every key must name a `:parameter` of `route`. |
| `query` | Descriptors for query keys, in declaration order. |
| `unknownQueryKeys` | `error`, `warn`, `keep` or `drop`. Default `error`. |
| `repeatedSingleKeys` | `error`, `first` or `last`. Default `error`. |
| `hash` | `{ mode, params, unknownKeys, maxLength }`. Default `{ "mode": "none" }`. |

`hash.mode` is `none` (a fragment is a violation), `opaque` (one free-form
string, length-bounded by `hash.maxLength`) or `params` (a second parameter
list parsed with the same rules as the query).

### Descriptor fields

| Field | Applies to | Meaning |
| --- | --- | --- |
| `type` | all | `string` (default), `integer`, `boolean`, `enum`. |
| `values` | `enum` | Non-empty array of permitted strings. |
| `multiplicity` | query, hash params | `single` (default) or `repeatable`. |
| `maxCount` | `repeatable` | Maximum occurrences, 1 to 64. Default 16. |
| `required` | query, hash params | Absence is an error. |
| `default` | query, hash params | Serialized string applied when the key is absent. Mutually exclusive with `required`. |
| `min`, `max` | `integer` | Inclusive bounds. |
| `minLength`, `maxLength` | `string` | Inclusive character-count bounds. |
| `charset` | all | `any` (default), `digits`, `hex`, `alnum` or `slug` (lowercase letters, digits, `-`, `_`). |
| `emptyAllowed` | query, hash params | Permit `key=` with no value. Default `false`. |

Route parameters may not declare `multiplicity`, `required`, `default` or
`emptyAllowed`: the route pattern already decides whether they are present.

There is deliberately no user-supplied regular expression. `charset` covers the
common shapes without giving a contract file the power to make the checker
run for an unbounded time on an adversarial value.

## Unknown-key policies

| Policy | Finding | Value kept in state and re-serialized |
| --- | --- | --- |
| `error` | `error` | no |
| `warn` | `warning` | yes |
| `keep` | none | yes |
| `drop` | `info` | no |

## Repeated-key policies

`multiplicity: "repeatable"` accepts up to `maxCount` occurrences and keeps
their order and duplicates. For a `single` key that appears more than once,
`repeatedSingleKeys` decides: `error` reports an error and resolves the key to
no value, `first` and `last` report a warning and keep that occurrence.

## Rule catalog

Rule identifiers are stable. Renaming one is a breaking change and is recorded
in the changelog.

| ruleId | Severity | Meaning |
| --- | --- | --- |
| `contract-invalid` | error | The contract could not be normalized. Status `incomplete`. |
| `fixture-empty` | error | The fixture holds no URLs at all, so nothing was checked. Status `incomplete`. |
| `fixture-invalid` | error | The fixture is not a URL list, or an entry is not a URL. Status `incomplete`. |
| `input-unreadable` | error | A file could not be read or was not valid JSON. A parse failure is named by position; the document is not quoted back. Status `incomplete`. |
| `input-limit-exceeded` | error | A key, value or path exceeded a tool limit. Status `incomplete`. |
| `url-limit-exceeded` | error | The fixture holds more than `maxUrls` URLs. Status `incomplete`. |
| `url-too-long` | error | A URL exceeded `maxUrlLength`. Status `incomplete`. |
| `query-pair-limit-exceeded` | error | A parameter list exceeded `maxQueryPairs`. Status `incomplete`. |
| `time-limit-exceeded` | error | The run stopped at the declared time budget. Status `incomplete`. |
| `url-unparsable` | error | The entry was not a string URL. |
| `malformed-percent-encoding` | error | A `%` was not followed by two hexadecimal digits. |
| `invalid-utf8-sequence` | error | The percent-decoded bytes are not valid UTF-8, or the input held an unpaired surrogate. |
| `control-character-in-value` | error | A decoded value carries a C0 control character or DEL. |
| `bare-key-not-allowed` | error | A key appeared without `=`, so it has no serialized value. |
| `route-mismatch` | error | The path does not match the declared route pattern. |
| `route-param-invalid` | error | A route parameter failed its descriptor. |
| `missing-required-key` | error | A `required` key is absent or resolved to no value. |
| `unknown-query-key` | error, warning or info | A query key is not declared. Severity follows `unknownQueryKeys`. |
| `unknown-hash-key` | error, warning or info | A fragment key is not declared. Severity follows `hash.unknownKeys`. |
| `repeated-single-key` | error or warning | A `single` key appeared more than once. Severity follows `repeatedSingleKeys`. |
| `repeat-count-exceeded` | error | A `repeatable` key exceeded its declared `maxCount`. |
| `empty-value-not-allowed` | error | `key=` was sent where `emptyAllowed` is false. |
| `invalid-enum-value` | error | The value is not one of the declared `values`. |
| `invalid-integer-value` | error | The value is not a decimal integer. |
| `integer-out-of-range` | error | The integer is outside the declared `min`/`max`. |
| `invalid-boolean-value` | error | The value is not exactly `true` or `false`. |
| `value-length-out-of-range` | error | The value is outside the declared `minLength`/`maxLength`, or the fragment exceeded `hash.maxLength`. |
| `charset-violation` | error | The value holds a character outside the declared `charset`. |
| `hash-not-allowed` | error | A fragment was present where `hash.mode` is `none`. |
| `default-applied` | info | A declared default supplied a value for an absent key. |
| `round-trip-mismatch` | error | `parse -> serialize -> parse` did not reproduce the same values. |

`status` is `incomplete` whenever any finding is one of the nine rules marked
`Status incomplete` above, `fail` when any other error is present, and `pass`
only when the tool evaluated at least one URL and none failed. A fixture with
no URLs in it is `fixture-empty` and `incomplete`: a run that checked nothing
is never reported as a pass, because it is an absence of evidence rather than
evidence of conformance.

## Parse and serialize rules

Decoding:

- a query or fragment parameter list splits on `&`; empty segments are skipped.
- a pair splits at its first `=`. No `=` at all is `bare-key-not-allowed`,
  because a key with no serialized value cannot be round-tripped.
- `+` decodes to a space in query and fragment parameter values, matching
  `application/x-www-form-urlencoded`. `+` in a path segment stays a literal
  plus.
- `%XX` decodes to a byte. The accumulated bytes are decoded as UTF-8 with a
  fatal decoder, so a truncated sequence such as `%E0%A4`, an overlong form, or
  a surrogate half such as `%ED%A0%80` is reported instead of becoming U+FFFD.

Encoding:

- only the RFC 3986 unreserved set `A-Z a-z 0-9 - . _ ~` is written literally.
  Every other character is percent-encoded from its UTF-8 bytes with uppercase
  hexadecimal digits. A space becomes `%20`, never `+`.
- declared keys are emitted in contract declaration order, then kept unknown
  keys in the order they were first seen in the source URL.
- an integer is written in its canonical form, so `page=007` re-serializes as
  `page=7`; a boolean is written as `true` or `false`.
- a value equal to its declared default is omitted unless `includeDefaults` is
  set, because parsing will supply it again.

This means serialization is **canonical**, not byte-preserving: it returns the
same values, not necessarily the same characters. Serializing a parsed state a
second time is a fixed point.

### What is relied on from node:url

Nothing. `URL` and `URLSearchParams` are not used for decoding, and the package
imports no module that does. `URLSearchParams` repairs malformed input in ways
this tool must report: an invalid escape or a truncated UTF-8 sequence becomes
U+FFFD, `?a` and `?a=` both read as an empty string, and `+` is unconditionally
a space including in a path. The checker therefore implements its own splitter,
percent decoder and encoder, which is also why it can run on relative URLs with
no base.

## Declared limits

| Limit | Value | On breach |
| --- | --- | --- |
| input file size | 1 048 576 bytes | `input-unreadable` |
| JSON nesting depth | 20 | `contract-invalid` |
| URLs per fixture | 1 000 | `url-limit-exceeded` |
| URL length | 8 192 characters | `url-too-long` |
| parameter pairs per list | 256 | `query-pair-limit-exceeded` |
| key length | 256 characters | `input-limit-exceeded` |
| value length | 4 096 characters | `input-limit-exceeded` |
| path segments | 64 | `input-limit-exceeded` |
| declared keys or enum members | 256 | `contract-invalid` |
| repeat count ceiling | 64 | `contract-invalid` |
| evidence excerpt | 80 characters | truncated with a trailing ellipsis |
| wall budget | 10 000 ms, `--timeout-ms` | `time-limit-exceeded` |

No limit is ever applied as a silent truncation: each one produces a named
finding and an `incomplete` report.

## Determinism guarantee

Running the tool twice over identical inputs produces byte-identical stdout.

- All ordering uses a plain `(a < b ? -1 : a > b ? 1 : 0)` comparator over
  UTF-16 code units. `localeCompare` is never called, because its result
  depends on the ICU data compiled into a particular Node build.
- Findings sort by `location.file`, then the fixture index of the URL, then
  `location.pointer`, then `ruleId`, then `message`, then `evidence`, then the
  order in which they were produced. The fixture index is compared as a number,
  so `/urls/10` follows `/urls/9`.
- No wall-clock reading affects output content. The only clock is the time
  budget, which is injectable (`clock` in `checkUrls`) and, when it fires,
  reports `time-limit-exceeded` rather than quietly shortening the run.
- No filesystem enumeration, hash iteration order or random source is used.
- `location.file` is the input path as given, relative; an absolute path is
  reduced to its basename so a report does not depend on the host layout. A
  finding names the input it belongs to, so an input that could not be read or
  parsed is attributed to that file and never to the other input.

One caveat inherited from JSON: declaration order for `query` and `hash.params`
is JavaScript object key order, which places integer-like key names such as
`"2"` before all other names. It is deterministic for a given contract file,
but if your keys are numeric strings the serialized order may surprise you.

## Evidence handling

`evidence` is the offending raw token only, capped at 80 characters, with
control characters, U+2028 and U+2029 rewritten as escape text. Fixture URLs
are data: nothing read from a URL changes what the tool checks, and no value is
echoed anywhere it could be read as an instruction.

A file that will not parse is named by position, line and column and is never
quoted back: `fixture is not valid JSON: Expected ',' or ']' after array
element in JSON at position 33 (line 1 column 34)`. V8's own parse error embeds
the document it choked on, so a contract or fixture short enough to be only a
credential would otherwise be reproduced in full -- in the report on stdout and
again in the human summary on stderr. Redaction does not cover it: the quoted
copy carries no control characters and sits at the front of the message.
