import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ContractError,
  LIMITS,
  UrlStateError,
  checkUrls,
  decodeComponent,
  encodeComponent,
  exitCodeFor,
  normalizeContract,
  parseUrlState,
  serializeUrlState,
  splitUrl,
  stateFingerprint
} from '../src/index.mjs'

const BASE = {
  route: '/catalog/:category/search',
  params: { category: { type: 'enum', values: ['cable', 'tools'] } },
  query: {
    q: { type: 'string', required: true, maxLength: 120 },
    tag: { type: 'string', multiplicity: 'repeatable', maxCount: 3, charset: 'slug' },
    page: { type: 'integer', default: '1', min: 1, max: 500 },
    sort: { type: 'enum', values: ['newest', 'relevance'], default: 'relevance' },
    inStock: { type: 'boolean', default: 'false' }
  },
  unknownQueryKeys: 'error',
  repeatedSingleKeys: 'error',
  hash: {
    mode: 'params',
    params: { panel: { type: 'enum', values: ['compare', 'filters'] } },
    unknownKeys: 'warn'
  }
}

function contractWith(overrides = {}) {
  return normalizeContract({ ...structuredClone(BASE), ...overrides })
}

function rules(findings) {
  return findings.map((item) => item.ruleId).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

test('acceptance: parse -> serialize -> parse preserves every permitted value', () => {
  const contract = contractWith()
  const awkward = [
    'plain',
    'with space',
    'amp & equals = hash # plus + percent %',
    'slash / question ? colon :',
    '\u00c9lectrique caf\u00e9',
    '\u4e2d\u6587\u30c6\u30b9\u30c8',
    '\ud83d\udd27 emoji',
    'tilde~dot.dash-underscore_',
    '"quoted" and \u2018curly\u2019'
  ]
  for (const value of awkward) {
    const url = `/catalog/tools/search?q=${encodeComponent(value)}&tag=alpha&tag=beta&page=7&sort=newest&inStock=true#panel=filters`
    const first = parseUrlState(contract, url)
    assert.deepEqual(first.findings.filter((item) => item.severity === 'error'), [], `no errors for ${value}`)
    assert.equal(first.state.query.q, value)

    for (const includeDefaults of [false, true]) {
      const serialized = serializeUrlState(contract, first.state, { includeDefaults })
      const second = parseUrlState(contract, serialized)
      assert.deepEqual(second.findings.filter((item) => item.severity === 'error'), [])
      assert.equal(second.state.query.q, value, `q survived the round trip for ${value}`)
      assert.deepEqual(second.state.query.tag, ['alpha', 'beta'])
      assert.equal(second.state.query.page, 7)
      assert.equal(second.state.params.category, 'tools')
      assert.equal(second.state.hash.params.panel, 'filters')
      assert.equal(stateFingerprint(second.state), stateFingerprint(first.state))
    }
  }
})

test('acceptance: serialization is canonical and idempotent from the second pass on', () => {
  const contract = contractWith()
  const once = parseUrlState(contract, '/catalog/tools/search?q=torque+wrench&page=007')
  const first = serializeUrlState(contract, once.state)
  const twice = parseUrlState(contract, first)
  const second = serializeUrlState(contract, twice.state)
  assert.equal(once.state.query.page, 7, 'leading zeros coerce to the same integer')
  assert.equal(once.state.query.q, 'torque wrench', 'a "+" in a query decodes to a space')
  assert.equal(first, '/catalog/tools/search?q=torque%20wrench&page=7')
  assert.equal(second, first)
})

test('encodeComponent and decodeComponent are inverses', () => {
  for (const value of ['', 'a', '~._-', '%', '+', ' ', '\u00e9', '\ud83d\ude80', 'a/b?c#d']) {
    const encoded = encodeComponent(value)
    const decoded = decodeComponent(encoded, { plusAsSpace: true })
    assert.equal(decoded.ok, true)
    assert.equal(decoded.value, value)
  }
})

test('malformed percent encoding is reported, never thrown', () => {
  const contract = contractWith()
  const cases = [
    ['/catalog/tools/search?q=%E0%A4', 'invalid-utf8-sequence'],
    ['/catalog/tools/search?q=%ZZ', 'malformed-percent-encoding'],
    ['/catalog/tools/search?q=%', 'malformed-percent-encoding'],
    ['/catalog/tools/search?q=%A', 'malformed-percent-encoding'],
    ['/catalog/tools/search?q=%C3%28', 'invalid-utf8-sequence'],
    ['/catalog/tools/search?q=%ED%A0%80', 'invalid-utf8-sequence']
  ]
  for (const [url, ruleId] of cases) {
    const parsed = parseUrlState(contract, url)
    assert.ok(rules(parsed.findings).includes(ruleId), `${url} reports ${ruleId}`)
    assert.equal(parsed.state.query.q, undefined, 'no repaired value leaks into the state')
  }
  const surrogate = parseUrlState(contract, '/catalog/tools/search?q=\ud800')
  assert.ok(rules(surrogate.findings).includes('invalid-utf8-sequence'))
})

test('a percent-decoded control character is reported and dropped', () => {
  const contract = contractWith()
  const parsed = parseUrlState(contract, '/catalog/tools/search?q=a%00b')
  assert.ok(rules(parsed.findings).includes('control-character-in-value'))
  assert.equal(parsed.state.query.q, undefined)
  const evidence = parsed.findings.find((item) => item.ruleId === 'control-character-in-value').evidence
  assert.equal(evidence.includes('\u0000'), false, 'evidence never carries a raw control character')
})

test('unknown keys follow each declared policy', () => {
  const url = '/catalog/tools/search?q=drill&utm_source=news'
  const expectations = [
    ['error', 'error', false],
    ['warn', 'warning', true],
    ['keep', null, true],
    ['drop', 'info', false]
  ]
  for (const [policy, severity, kept] of expectations) {
    const contract = contractWith({ unknownQueryKeys: policy })
    const parsed = parseUrlState(contract, url)
    const unknown = parsed.findings.filter((item) => item.ruleId === 'unknown-query-key')
    if (severity === null) assert.equal(unknown.length, 0, 'the "keep" policy is silent')
    else {
      assert.equal(unknown.length, 1, `the "${policy}" policy reports once`)
      assert.equal(unknown[0].severity, severity)
    }
    assert.equal(parsed.state.unknownQuery.length, kept ? 1 : 0, `"${policy}" keeps: ${kept}`)
    if (kept) {
      assert.deepEqual(parsed.state.unknownQuery[0], { key: 'utm_source', value: 'news' })
      const again = parseUrlState(contract, serializeUrlState(contract, parsed.state))
      assert.deepEqual(again.state.unknownQuery, parsed.state.unknownQuery, 'kept keys survive serialization')
    } else {
      assert.equal(serializeUrlState(contract, parsed.state).includes('utm_source'), false)
    }
  }
})

test('repeated keys follow the declared multiplicity and policy', () => {
  const repeated = '/catalog/tools/search?q=drill&q=saw'
  const strict = parseUrlState(contractWith(), repeated)
  const strictFinding = strict.findings.find((item) => item.ruleId === 'repeated-single-key')
  assert.equal(strictFinding.severity, 'error')
  assert.equal(strict.state.query.q, undefined, 'an errored single key resolves to no value')

  const first = parseUrlState(contractWith({ repeatedSingleKeys: 'first' }), repeated)
  assert.equal(first.state.query.q, 'drill')
  assert.equal(first.findings.find((item) => item.ruleId === 'repeated-single-key').severity, 'warning')

  const last = parseUrlState(contractWith({ repeatedSingleKeys: 'last' }), repeated)
  assert.equal(last.state.query.q, 'saw')

  const contract = contractWith()
  const many = parseUrlState(contract, '/catalog/tools/search?q=x&tag=a&tag=b&tag=c')
  assert.deepEqual(many.state.query.tag, ['a', 'b', 'c'], 'a repeatable key keeps order and duplicates')
  const tooMany = parseUrlState(contract, '/catalog/tools/search?q=x&tag=a&tag=b&tag=c&tag=d')
  assert.ok(rules(tooMany.findings).includes('repeat-count-exceeded'))
  assert.equal(tooMany.state.query.tag, undefined)
  const duplicates = parseUrlState(contract, '/catalog/tools/search?q=x&tag=a&tag=a')
  assert.deepEqual(duplicates.state.query.tag, ['a', 'a'])
})

test('defaults are applied on parse and omitted from the serialized form', () => {
  const contract = contractWith()
  const parsed = parseUrlState(contract, '/catalog/tools/search?q=drill')
  assert.equal(parsed.state.query.page, 1)
  assert.equal(parsed.state.query.sort, 'relevance')
  assert.equal(parsed.state.query.inStock, false)
  assert.deepEqual(parsed.state.defaulted, ['page', 'sort', 'inStock'])
  assert.equal(serializeUrlState(contract, parsed.state), '/catalog/tools/search?q=drill')
  assert.equal(
    serializeUrlState(contract, parsed.state, { includeDefaults: true }),
    '/catalog/tools/search?q=drill&page=1&sort=relevance&inStock=false'
  )
  const explicit = parseUrlState(contract, '/catalog/tools/search?q=drill&page=1')
  assert.equal(stateFingerprint(explicit.state), stateFingerprint(parsed.state), 'provenance is not a value')
})

test('typed values, ranges, charsets, emptiness and routes are enforced', () => {
  const contract = contractWith()
  const expectations = [
    ['/catalog/tools/search?q=drill&page=abc', 'invalid-integer-value'],
    ['/catalog/tools/search?q=drill&page=9999', 'integer-out-of-range'],
    ['/catalog/tools/search?q=drill&page=0', 'integer-out-of-range'],
    ['/catalog/tools/search?q=drill&sort=cheapest', 'invalid-enum-value'],
    ['/catalog/tools/search?q=drill&inStock=yes', 'invalid-boolean-value'],
    ['/catalog/tools/search?q=drill&tag=Shielded', 'charset-violation'],
    ['/catalog/tools/search?q=', 'empty-value-not-allowed'],
    ['/catalog/tools/search?q=drill&debug', 'bare-key-not-allowed'],
    ['/catalog/tools/search?page=2', 'missing-required-key'],
    ['/catalog/adhesives/search?q=drill', 'route-param-invalid'],
    ['/catalog/tools?q=drill', 'route-mismatch'],
    ['/other/tools/search?q=drill', 'route-mismatch']
  ]
  for (const [url, ruleId] of expectations) {
    assert.ok(rules(parseUrlState(contract, url).findings).includes(ruleId), `${url} reports ${ruleId}`)
  }
})

test('a declared hash mode is honoured', () => {
  const none = contractWith({ hash: { mode: 'none' } })
  assert.ok(rules(parseUrlState(none, '/catalog/tools/search?q=a#x').findings).includes('hash-not-allowed'))

  const opaque = contractWith({ hash: { mode: 'opaque', maxLength: 32 } })
  const parsed = parseUrlState(opaque, '/catalog/tools/search?q=a#section%20two')
  assert.deepEqual(parsed.state.hash, { mode: 'opaque', value: 'section two' })
  assert.equal(serializeUrlState(opaque, parsed.state), '/catalog/tools/search?q=a#section%20two')

  const params = contractWith()
  const hashed = parseUrlState(params, '/catalog/tools/search?q=a#panel=compare&scroll=12')
  assert.equal(hashed.state.hash.params.panel, 'compare')
  assert.deepEqual(hashed.state.hash.unknown, [{ key: 'scroll', value: '12' }])
  assert.equal(rules(hashed.findings).includes('unknown-hash-key'), true)
})

test('splitUrl keeps origin, path, query and fragment apart', () => {
  assert.deepEqual(splitUrl('https://a.test/p?x=1#y=2'), {
    origin: 'https://a.test', path: '/p', query: 'x=1', fragment: 'y=2'
  })
  assert.deepEqual(splitUrl('/p'), { origin: '', path: '/p', query: null, fragment: null })
  assert.deepEqual(splitUrl('/p#f?notquery'), { origin: '', path: '/p', query: null, fragment: 'f?notquery' })
  assert.deepEqual(splitUrl('?x=1'), { origin: '', path: '/', query: 'x=1', fragment: null })
})

test('an invalid contract is rejected with every problem at once', () => {
  assert.throws(() => normalizeContract('nope'), ContractError)
  try {
    normalizeContract({
      route: 'catalog',
      query: { a: { type: 'nope' }, b: { type: 'enum' }, c: { type: 'integer', min: 5, max: 1 } },
      unknownQueryKeys: 'maybe'
    })
    assert.fail('expected ContractError')
  } catch (error) {
    assert.ok(error instanceof ContractError)
    assert.ok(error.problems.length >= 4, `reported ${error.problems.length} problems at once`)
  }
  assert.throws(
    () => normalizeContract({ query: { page: { type: 'integer', min: 1, default: '0' } } }),
    /rejected by its own rules/
  )
  assert.throws(
    () => normalizeContract({ query: { q: { type: 'string', required: true, default: 'x' } } }),
    /both required and defaulted/
  )
})

test('an unserializable state is refused, not repaired', () => {
  const contract = contractWith()
  assert.throws(() => encodeComponent('\ud800'), UrlStateError)
  const state = parseUrlState(contract, '/catalog/tools/search?q=a').state
  state.query.tag = 'not-an-array'
  assert.throws(() => serializeUrlState(contract, state), UrlStateError)
})

test('checkUrls reports an invalid contract as incomplete, never as a pass', () => {
  const report = checkUrls({ query: { q: { type: 'wrong' } } }, ['/a'])
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.equal(report.findings[0].ruleId, 'contract-invalid')
  assert.equal(report.summary.checked, 0)
})

test('checkUrls reports an unusable fixture as incomplete', () => {
  const contract = structuredClone(BASE)
  assert.equal(checkUrls(contract, { nope: true }).status, 'incomplete')
  assert.equal(checkUrls(contract, [{ nope: true }]).findings[0].ruleId, 'fixture-invalid')
  assert.equal(checkUrls(contract, [{ nope: true }]).status, 'incomplete')
})

test('checkUrls refuses to pass a fixture holding no URLs', () => {
  const contract = structuredClone(BASE)
  for (const fixture of [[], { urls: [] }]) {
    const report = checkUrls(contract, fixture, { sourceFile: 'urls.json' })
    assert.equal(report.status, 'incomplete')
    assert.equal(exitCodeFor(report), 2)
    assert.equal(report.summary.checked, 0)
    assert.deepEqual(rules(report.findings), ['fixture-empty'])
    assert.equal(report.findings[0].location.file, 'urls.json')
    assert.equal(report.findings[0].location.pointer, '/urls')
  }
})

test('declared bounds produce an explicit finding, never a silent truncation', () => {
  const contract = structuredClone(BASE)
  const long = `/catalog/tools/search?q=${'x'.repeat(LIMITS.maxUrlLength)}`
  const tooLong = checkUrls(contract, [long])
  assert.equal(tooLong.findings[0].ruleId, 'url-too-long')
  assert.equal(tooLong.status, 'incomplete')
  assert.equal(exitCodeFor(tooLong), 2)

  const pairs = Array.from({ length: LIMITS.maxQueryPairs + 1 }, (unused, index) => `k${index}=1`).join('&')
  const tooMany = checkUrls(contract, [`/catalog/tools/search?${pairs}`])
  assert.equal(tooMany.findings[0].ruleId, 'query-pair-limit-exceeded')
  assert.equal(tooMany.status, 'incomplete')

  const many = Array.from({ length: LIMITS.maxUrls + 1 }, () => '/catalog/tools/search?q=a')
  const tooManyUrls = checkUrls(contract, many)
  assert.equal(tooManyUrls.findings[0].ruleId, 'url-limit-exceeded')
  assert.equal(tooManyUrls.status, 'incomplete')

  const deep = { query: {} }
  let node = deep.query
  for (let depth = 0; depth < LIMITS.maxJsonDepth + 2; depth += 1) node = (node.nested = {})
  assert.throws(() => normalizeContract(deep), /nests deeper/)
})

test('the time budget is enforced against an injected clock', () => {
  const contract = structuredClone(BASE)
  let ticks = 0
  const clock = () => {
    ticks += 1
    return ticks * 10
  }
  const urls = Array.from({ length: 20 }, () => '/catalog/tools/search?q=a')
  const report = checkUrls(contract, urls, { timeoutMs: 30, clock })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.some((item) => item.ruleId === 'time-limit-exceeded'), true)
  assert.ok(report.summary.checked < 20, 'the run stopped instead of finishing past its budget')
})

test('the same input produces a byte-identical report twice', () => {
  const contract = structuredClone(BASE)
  const urls = [
    '/catalog/tools/search?q=drill&utm_source=news',
    '/catalog/cable/search?q=cat6&tag=b&tag=a',
    '/catalog/tools/search?q=%E0%A4',
    '/catalog/tools/search?q=drill&q=saw',
    '/catalog/tools/search?q=ok#panel=filters&scroll=1'
  ]
  const clock = () => 0
  const first = JSON.stringify(checkUrls(contract, urls, { sourceFile: 'urls.json', clock }), null, 2)
  const second = JSON.stringify(checkUrls(contract, urls, { sourceFile: 'urls.json', clock }), null, 2)
  assert.equal(first, second)

  const report = JSON.parse(first)
  assert.equal(report.status, 'fail')
  assert.ok(report.findings.length > 0)
  assert.deepEqual(
    report.findings.map((item) => item.location.file),
    report.findings.map(() => 'urls.json'),
    'every finding stays relative to the declared input'
  )
  const pointers = report.findings.map((item) => item.location.pointer)
  const indices = pointers.map((pointer) => Number(pointer.split('/')[2]))
  assert.deepEqual(indices, indices.slice().sort((a, b) => a - b), 'findings are grouped by URL index in order')
})

test('a clean fixture passes and every URL round trips', () => {
  const contract = structuredClone(BASE)
  const report = checkUrls(contract, [
    '/catalog/tools/search?q=drill',
    '/catalog/cable/search?q=cat6&tag=a&tag=b&page=2',
    'https://example.test/catalog/tools/search?q=%C3%89lectrique#panel=filters'
  ])
  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.roundTrips, 3)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'url-state-contract-checker')
})
