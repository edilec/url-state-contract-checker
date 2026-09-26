import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'

/**
 * The parse-failure detail is derived from the document, so it is pinned here
 * against the two ways it can go wrong.
 *
 * It can say too much. V8 reports a parse failure two ways and one of them
 * quotes the input back, so a helper that looks for `at position` BEFORE it
 * recognises the quoting shape finds that phrase inside the quoted span
 * whenever the document itself supplies it, and slices the document straight
 * back out:
 *
 *   document:  at position 1
 *   V8 says:   Unexpected token 'a', "at position 1" is not valid JSON
 *   returned:  Unexpected token 'a', "at position 1
 *
 * It can also say too little. A helper that answered `the document could not be
 * parsed as JSON` for everything would leak nothing and diagnose nothing, so
 * the position, line and column are pinned as hard as the absence of the
 * document is.
 *
 * The canary is `AKIAIOSFODNN7EXAMPLE`, the access key id AWS publishes in its
 * own documentation. It is not a credential; it is the shape of one.
 */

const CANARY = 'AKIAIOSFODNN7EXAMPLE'
const UNPARSEABLE = 'the document could not be parsed as JSON'

/** The error V8 raises for a document that must not parse. */
function refusal(document) {
  try {
    JSON.parse(document)
  } catch (error) {
    return error
  }
  throw new Error(`${JSON.stringify(document)} parsed, so it pins nothing`)
}

function detailFor(document) {
  return parseFailureDetail(refusal(document))
}

/**
 * No prefix of the document four characters or longer survives into the detail.
 * Four, because V8 quotes only the first ten characters of a long document: a
 * check for the whole value would pass against a detail still carrying
 * `AKIAIOSFOD`, and a check for ten would pass against one carrying `AKIA`.
 */
function assertNoPrefixOf(document, detail, label) {
  for (let length = 4; length <= document.length; length += 1) {
    const prefix = document.slice(0, length)
    assert.equal(
      detail.includes(prefix),
      false,
      `${label}: the detail carries ${JSON.stringify(prefix)} -- ${JSON.stringify(detail)}`
    )
  }
}

test('a document whose own text reads "at position 1" is not sliced back out', () => {
  const document = 'at position 1'
  const message = refusal(document).message
  assert.equal(message.includes(document), true, 'V8 no longer quotes the input; this pin needs revisiting')

  const detail = detailFor(document)
  assert.equal(detail.includes('"'), false, `a quote means a quoted span survived: ${JSON.stringify(detail)}`)
  assert.equal(detail.includes(document), false, `the document came back out: ${JSON.stringify(detail)}`)
  // Pinned exactly: recognising the quoting shape first is what makes this
  // both leak-free AND still a diagnostic. Falling back to the generic
  // sentence here would hide the same ordering defect.
  assert.equal(detail, "unexpected token 'a' at the start of the document")
})

test('a contract that is nothing but a credential is not quoted back', () => {
  const detail = detailFor(CANARY)
  assert.equal(detail.includes('"'), false)
  assertNoPrefixOf(CANARY, detail, 'credential-only document')
  assert.equal(detail, "unexpected token 'A' at the start of the document")
})

test('a long document with a sensitive head keeps none of that head', () => {
  const document = `${CANARY} and then several hundred more characters of contract that never parse`
  const detail = detailFor(document)
  assert.equal(detail.includes('"'), false)
  assertNoPrefixOf(document, detail, 'long document')
  assert.equal(detail, "unexpected token 'A' at the start of the document")
})

test('a credential further inside the document is not quoted back either', () => {
  const document = `{"contract": {}, "urls": ${CANARY}}`
  const detail = detailFor(document)
  assert.equal(detail.includes('"'), false)
  assertNoPrefixOf(CANARY, detail, 'credential inside the document')
  assert.equal(detail, "unexpected token 'A' inside the document")
})

test('a quoted span carrying a newline is still recognised as a quoted span', () => {
  // The quoting regex needs the `s` flag: without it `.*` stops at the line
  // feed, the shape is missed, and the message falls through to a branch that
  // was never meant to see it.
  const document = '}x\n'
  const message = refusal(document).message
  assert.equal(message.includes('\n'), true, 'the quoted span really does carry the newline')

  const detail = detailFor(document)
  assert.equal(detail.includes('"'), false)
  assert.equal(detail.includes('\n'), false)
  assert.equal(detail, "unexpected token '}' at the start of the document")
})

test('the position, line and column survive -- a detail that says nothing is a different defect', () => {
  assert.equal(
    detailFor('{"page": 1 "size": 2}'),
    "Expected ',' or '}' after property value in JSON at position 11 (line 1 column 12)"
  )
  assert.match(detailFor('{"page": 1, '), /at position \d+ \(line \d+ column \d+\)$/)
  assert.equal(
    detailFor('{"page": 1} trailing'),
    'Unexpected non-whitespace character after JSON at position 12 (line 1 column 13)'
  )
})

test('an empty document passes through unchanged', () => {
  assert.equal(detailFor(''), 'Unexpected end of JSON input')
})

test('a wording this tool was never taught is refused rather than guessed at', () => {
  assert.equal(
    parseFailureDetail(new Error(`Unexpected token 'A', "${CANARY}" is not valid JSON at position 0`)),
    UNPARSEABLE,
    'a double quote surviving to the end means the snippet survived with it'
  )
  assert.equal(parseFailureDetail(new Error('something new from a future V8')), UNPARSEABLE)
  assert.equal(parseFailureDetail(undefined), UNPARSEABLE)
})
