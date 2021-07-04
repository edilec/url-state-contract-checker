// Percent codec, URL splitting, contract-aware parse and serialize.
//
// node:url / URLSearchParams is deliberately NOT used for decoding. It repairs
// malformed input silently: an invalid escape or a truncated UTF-8 sequence
// becomes U+FFFD, a bare key and an empty value both become "", and "+" is
// always a space. This tool has to report those cases, so it decodes itself.

import { LIMITS, coerceValue, formatValue } from './contract.mjs'

const UNRESERVED = new Set()
for (const range of [[0x30, 0x39], [0x41, 0x5a], [0x61, 0x7a]]) {
  for (let code = range[0]; code <= range[1]; code += 1) UNRESERVED.add(code)
}
for (const code of [0x2d, 0x2e, 0x5f, 0x7e]) UNRESERVED.add(code)

const HEX_DIGITS = '0123456789ABCDEF'

export class UrlStateError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UrlStateError'
  }
}

function hexValue(code) {
  if (code >= 0x30 && code <= 0x39) return code - 0x30
  if (code >= 0x41 && code <= 0x46) return code - 0x37
  if (code >= 0x61 && code <= 0x66) return code - 0x57
  return -1
}

function pushUtf8(bytes, code) {
  if (code < 0x80) {
    bytes.push(code)
  } else if (code < 0x800) {
    bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
  } else if (code < 0x10000) {
    bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
  } else {
    bytes.push(
      0xf0 | (code >> 18),
      0x80 | ((code >> 12) & 0x3f),
      0x80 | ((code >> 6) & 0x3f),
      0x80 | (code & 0x3f)
    )
  }
}

export function redactEvidence(raw) {
  const characters = []
  for (const character of String(raw)) {
    const code = character.codePointAt(0)
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
      characters.push('\\u' + code.toString(16).padStart(4, '0'))
    } else {
      characters.push(character)
    }
  }
  if (characters.length > LIMITS.maxEvidenceLength) {
    return characters.slice(0, LIMITS.maxEvidenceLength - 1).join('') + '…'
  }
  return characters.join('')
}

/**
 * Strictly percent-decode one URL component.
 * Returns { ok: true, value } or { ok: false, ruleId, message }.
 * Never throws on hostile input.
 */
export function decodeComponent(raw, { plusAsSpace = false } = {}) {
  const bytes = []
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]
    if (character === '%') {
      const high = index + 1 < raw.length ? hexValue(raw.charCodeAt(index + 1)) : -1
      const low = index + 2 < raw.length ? hexValue(raw.charCodeAt(index + 2)) : -1
      if (high < 0 || low < 0) {
        return {
          ok: false,
          ruleId: 'malformed-percent-encoding',
          message: `"%" at offset ${index} is not followed by two hexadecimal digits`
        }
      }
      bytes.push(high * 16 + low)
      index += 2
      continue
    }
    if (character === '+' && plusAsSpace) {
      bytes.push(0x20)
      continue
    }
    const code = raw.codePointAt(index)
    if (code >= 0xd800 && code <= 0xdfff) {
      return {
        ok: false,
        ruleId: 'invalid-utf8-sequence',
        message: `unpaired surrogate U+${code.toString(16).toUpperCase()} at offset ${index}`
      }
    }
    if (code > 0xffff) index += 1
    pushUtf8(bytes, code)
  }
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes))
    return { ok: true, value }
  } catch {
    return {
      ok: false,
      ruleId: 'invalid-utf8-sequence',
      message: 'percent-decoded bytes are not valid UTF-8'
    }
  }
}

/**
 * Percent-encode one component using only the RFC 3986 unreserved set.
 * Round-tripping is the point: decodeComponent(encodeComponent(v)) === v.
 */
export function encodeComponent(value) {
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index)
    if (code >= 0xd800 && code <= 0xdfff) {
      throw new UrlStateError(`value contains an unpaired surrogate at offset ${index} and cannot be encoded`)
    }
    if (UNRESERVED.has(code)) {
      out += value[index]
      continue
    }
    if (code > 0xffff) index += 1
    const bytes = []
    pushUtf8(bytes, code)
    for (const byte of bytes) out += '%' + HEX_DIGITS[byte >> 4] + HEX_DIGITS[byte & 0x0f]
  }
  return out
}

function hasControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** Split a URL into origin, path, raw query and raw fragment without decoding. */
export function splitUrl(url) {
  let rest = url
  let fragment = null
  const hashAt = rest.indexOf('#')
  if (hashAt >= 0) {
    fragment = rest.slice(hashAt + 1)
    rest = rest.slice(0, hashAt)
  }
  let query = null
  const questionAt = rest.indexOf('?')
  if (questionAt >= 0) {
    query = rest.slice(questionAt + 1)
    rest = rest.slice(0, questionAt)
  }
  let origin = ''
  const schemeAt = rest.indexOf('://')
  if (schemeAt > 0 && !rest.slice(0, schemeAt).includes('/')) {
    const pathAt = rest.indexOf('/', schemeAt + 3)
    origin = pathAt >= 0 ? rest.slice(0, pathAt) : rest
    rest = pathAt >= 0 ? rest.slice(pathAt) : '/'
  }
  return { origin, path: rest.length === 0 ? '/' : rest, query, fragment }
}

function splitPairs(raw) {
  const pairs = []
  for (const chunk of raw.split('&')) {
    if (chunk.length === 0) continue
    const equalsAt = chunk.indexOf('=')
    if (equalsAt < 0) pairs.push({ rawKey: chunk, rawValue: null, chunk })
    else pairs.push({ rawKey: chunk.slice(0, equalsAt), rawValue: chunk.slice(equalsAt + 1), chunk })
  }
  return pairs
}

function finding(ruleId, severity, message, pointer, evidence, suggestion) {
  const record = { ruleId, severity, message, pointer }
  if (evidence !== undefined && evidence !== null) record.evidence = redactEvidence(evidence)
  if (suggestion !== undefined && suggestion !== null) record.suggestion = suggestion
  return record
}

const UNKNOWN_SEVERITY = { error: 'error', warn: 'warning', keep: null, drop: 'info' }
const UNKNOWN_KEEPS = { error: false, warn: true, keep: true, drop: false }

// Collect declared pairs into ordered buckets, reporting decode failures.
function collectPairs(raw, descriptors, policy, pointerBase, findings) {
  const byKey = new Map()
  const unknown = []
  const pairs = splitPairs(raw)
  if (pairs.length > LIMITS.maxQueryPairs) {
    findings.push(finding(
      'query-pair-limit-exceeded',
      'error',
      `parameter list holds ${pairs.length} pairs, above the ${LIMITS.maxQueryPairs} limit`,
      pointerBase,
      null,
      'split the state across fewer parameters or raise the declared limit'
    ))
    return { byKey, unknown, aborted: true }
  }
  const declared = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]))

  for (const pair of pairs) {
    if (pair.rawKey.length > LIMITS.maxKeyLength) {
      findings.push(finding(
        'input-limit-exceeded', 'error',
        `a parameter name is longer than the ${LIMITS.maxKeyLength}-character tool limit`,
        pointerBase, pair.chunk
      ))
      continue
    }
    const decodedKey = decodeComponent(pair.rawKey, { plusAsSpace: true })
    if (!decodedKey.ok) {
      findings.push(finding(
        decodedKey.ruleId, 'error',
        `parameter name could not be decoded: ${decodedKey.message}`,
        pointerBase, pair.chunk,
        'percent-encode the name with complete, valid escapes'
      ))
      continue
    }
    const key = decodedKey.value
    const pointer = `${pointerBase}/${key}`

    if (pair.rawValue === null) {
      findings.push(finding(
        'bare-key-not-allowed', 'error',
        `"${key}" appears without "=" and has no serialized value`,
        pointer, pair.chunk,
        `write "${key}=" if an empty value is intended`
      ))
      continue
    }
    if (pair.rawValue.length > LIMITS.maxValueLength) {
      findings.push(finding(
        'input-limit-exceeded', 'error',
        `"${key}" carries more than the ${LIMITS.maxValueLength}-character tool limit`,
        pointer, pair.chunk
      ))
      continue
    }
    const decodedValue = decodeComponent(pair.rawValue, { plusAsSpace: true })
    if (!decodedValue.ok) {
      findings.push(finding(
        decodedValue.ruleId, 'error',
        `"${key}" could not be decoded: ${decodedValue.message}`,
        pointer, pair.chunk,
        'percent-encode the value with complete, valid escapes'
      ))
      continue
    }
    if (hasControlCharacter(decodedValue.value)) {
      findings.push(finding(
        'control-character-in-value', 'error',
        `"${key}" decodes to a control character, which no route state should carry`,
        pointer, pair.chunk,
        'reject the value upstream instead of transporting it in the URL'
      ))
      continue
    }

    if (!declared.has(key)) {
      const severity = UNKNOWN_SEVERITY[policy]
      if (severity !== null) {
        findings.push(finding(
          pointerBase === '/query' ? 'unknown-query-key' : 'unknown-hash-key',
          severity,
          `"${key}" is not declared by the contract; policy is "${policy}"`,
          pointer, decodedValue.value,
          policy === 'error' ? 'declare the key or remove it from the link' : null
        ))
      }
      if (UNKNOWN_KEEPS[policy]) unknown.push({ key, value: decodedValue.value })
      continue
    }
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push({ raw: decodedValue.value, chunk: pair.chunk })
  }
  return { byKey, unknown, aborted: false }
}

function resolveDeclared(descriptors, byKey, repeatedSingleKeys, pointerBase, findings) {
  const values = {}
  const defaulted = []
  for (const descriptor of descriptors) {
    const pointer = `${pointerBase}/${descriptor.key}`
    const occurrences = byKey.get(descriptor.key)
    if (occurrences === undefined || occurrences.length === 0) {
      if (descriptor.required) {
        findings.push(finding(
          'missing-required-key', 'error',
          `"${descriptor.key}" is required by the contract but absent`,
          pointer, null, `add "${descriptor.key}=" with a permitted value`
        ))
      } else if (descriptor.hasDefault) {
        values[descriptor.key] = descriptor.multiplicity === 'repeatable'
          ? [descriptor.defaultValue]
          : descriptor.defaultValue
        defaulted.push(descriptor.key)
        findings.push(finding(
          'default-applied', 'info',
          `"${descriptor.key}" is absent; the declared default "${descriptor.defaultRaw}" applies`,
          pointer, null, null
        ))
      }
      continue
    }

    let selected = occurrences
    if (descriptor.multiplicity === 'single' && occurrences.length > 1) {
      if (repeatedSingleKeys === 'error') {
        findings.push(finding(
          'repeated-single-key', 'error',
          `"${descriptor.key}" is declared single but appears ${occurrences.length} times`,
          pointer, occurrences.map((item) => item.chunk).join('&'),
          'declare the key repeatable, or set repeatedSingleKeys to "first" or "last"'
        ))
        continue
      }
      selected = repeatedSingleKeys === 'first' ? [occurrences[0]] : [occurrences[occurrences.length - 1]]
      findings.push(finding(
        'repeated-single-key', 'warning',
        `"${descriptor.key}" appears ${occurrences.length} times; the "${repeatedSingleKeys}" policy kept one`,
        pointer, occurrences.map((item) => item.chunk).join('&'), null
      ))
    }
    if (descriptor.multiplicity === 'repeatable' && selected.length > descriptor.maxCount) {
      findings.push(finding(
        'repeat-count-exceeded', 'error',
        `"${descriptor.key}" repeats ${selected.length} times, above the declared maximum ${descriptor.maxCount}`,
        pointer, null, `raise maxCount or send at most ${descriptor.maxCount} values`
      ))
      continue
    }

    const coerced = []
    let failed = false
    for (const occurrence of selected) {
      const result = coerceValue(descriptor, occurrence.raw)
      if (!result.ok) {
        findings.push(finding(result.ruleId, 'error', result.message, pointer, occurrence.chunk, null))
        failed = true
        continue
      }
      coerced.push(result.value)
    }
    if (failed || coerced.length === 0) continue
    values[descriptor.key] = descriptor.multiplicity === 'repeatable' ? coerced : coerced[0]
  }
  return { values, defaulted }
}

function matchRoute(contract, path, findings) {
  const segments = path.split('/').slice(1)
  if (segments.length > LIMITS.maxPathSegments) {
    findings.push(finding(
      'input-limit-exceeded', 'error',
      `path holds ${segments.length} segments, above the ${LIMITS.maxPathSegments} tool limit`,
      '/route', path
    ))
    return { segments: [], params: {}, ok: false }
  }
  const decoded = []
  for (const segment of segments) {
    const result = decodeComponent(segment, { plusAsSpace: false })
    if (!result.ok) {
      findings.push(finding(
        result.ruleId, 'error',
        `path segment could not be decoded: ${result.message}`,
        '/route', segment, 'percent-encode the segment with complete, valid escapes'
      ))
      return { segments: [], params: {}, ok: false }
    }
    decoded.push(result.value)
  }
  if (contract.route === null) return { segments: decoded, params: {}, ok: true }

  const pattern = contract.route.segments
  if (pattern.length !== decoded.length) {
    findings.push(finding(
      'route-mismatch', 'error',
      `path has ${decoded.length} segments; the route "${contract.route.pattern}" declares ${pattern.length}`,
      '/route', path, `send a path shaped like "${contract.route.pattern}"`
    ))
    return { segments: decoded, params: {}, ok: false }
  }
  const params = {}
  for (let index = 0; index < pattern.length; index += 1) {
    const declared = pattern[index]
    if (!declared.startsWith(':')) {
      if (declared !== decoded[index]) {
        findings.push(finding(
          'route-mismatch', 'error',
          `segment ${index + 1} is "${decoded[index]}"; the route declares "${declared}"`,
          '/route', path, `send a path shaped like "${contract.route.pattern}"`
        ))
        return { segments: decoded, params: {}, ok: false }
      }
      continue
    }
    params[declared.slice(1)] = decoded[index]
  }
  for (const descriptor of contract.params) {
    const result = coerceValue(descriptor, params[descriptor.key])
    if (!result.ok) {
      findings.push(finding(
        'route-param-invalid', 'error',
        `route parameter ${result.message}`,
        `/route/${descriptor.key}`, params[descriptor.key], null
      ))
      continue
    }
    params[descriptor.key] = result.value
  }
  return { segments: decoded, params, ok: true }
}

/**
 * Parse one URL against a normalized contract.
 * Returns { state, findings }. It never throws on input; a URL it cannot use
 * still produces findings and the most complete state it could recover.
 */
export function parseUrlState(contract, url) {
  const findings = []
  if (typeof url !== 'string') {
    findings.push(finding('url-unparsable', 'error', 'url must be a string', '/url', null, null))
    return { state: null, findings }
  }
  if (url.length > LIMITS.maxUrlLength) {
    findings.push(finding(
      'url-too-long', 'error',
      `url is ${url.length} characters, above the ${LIMITS.maxUrlLength} limit`,
      '/url', url.slice(0, LIMITS.maxEvidenceLength), 'move large state out of the URL'
    ))
    return { state: null, findings }
  }

  const parts = splitUrl(url)
  const route = matchRoute(contract, parts.path, findings)

  let query = { values: {}, defaulted: [], unknown: [] }
  if (parts.query !== null) {
    const collected = collectPairs(parts.query, contract.query, contract.unknownQueryKeys, '/query', findings)
    if (!collected.aborted) {
      const resolved = resolveDeclared(
        contract.query, collected.byKey, contract.repeatedSingleKeys, '/query', findings
      )
      query = { values: resolved.values, defaulted: resolved.defaulted, unknown: collected.unknown }
    }
  } else {
    const resolved = resolveDeclared(contract.query, new Map(), contract.repeatedSingleKeys, '/query', findings)
    query = { values: resolved.values, defaulted: resolved.defaulted, unknown: [] }
  }

  const hash = parseHash(contract, parts.fragment, findings)

  const state = {
    origin: parts.origin,
    segments: route.segments,
    params: route.params,
    query: query.values,
    unknownQuery: query.unknown,
    defaulted: query.defaulted,
    hash
  }
  return { state, findings }
}

function parseHash(contract, fragment, findings) {
  if (fragment === null) {
    if (contract.hash.mode === 'params') {
      const resolved = resolveDeclared(contract.hash.params, new Map(), contract.repeatedSingleKeys, '/hash', findings)
      if (Object.keys(resolved.values).length > 0 || contract.hash.params.some((d) => d.required)) {
        return { mode: 'params', params: resolved.values, unknown: [], defaulted: resolved.defaulted }
      }
    }
    return null
  }
  if (contract.hash.mode === 'none') {
    findings.push(finding(
      'hash-not-allowed', 'error',
      'the contract declares hash mode "none" but the URL carries a fragment',
      '/hash', fragment, 'drop the fragment or declare a hash mode'
    ))
    return null
  }
  if (contract.hash.mode === 'opaque') {
    if (fragment.length > contract.hash.maxLength) {
      findings.push(finding(
        'value-length-out-of-range', 'error',
        `fragment is longer than the declared maximum ${contract.hash.maxLength}`,
        '/hash', fragment, null
      ))
      return null
    }
    const decoded = decodeComponent(fragment, { plusAsSpace: false })
    if (!decoded.ok) {
      findings.push(finding(
        decoded.ruleId, 'error',
        `fragment could not be decoded: ${decoded.message}`,
        '/hash', fragment, 'percent-encode the fragment with complete, valid escapes'
      ))
      return null
    }
    if (hasControlCharacter(decoded.value)) {
      findings.push(finding(
        'control-character-in-value', 'error',
        'fragment decodes to a control character',
        '/hash', fragment, null
      ))
      return null
    }
    return { mode: 'opaque', value: decoded.value }
  }
  const collected = collectPairs(fragment, contract.hash.params, contract.hash.unknownKeys, '/hash', findings)
  if (collected.aborted) return null
  const resolved = resolveDeclared(
    contract.hash.params, collected.byKey, contract.repeatedSingleKeys, '/hash', findings
  )
  return { mode: 'params', params: resolved.values, unknown: collected.unknown, defaulted: resolved.defaulted }
}

function serializePairs(descriptors, values, unknown, includeDefaults) {
  const chunks = []
  for (const descriptor of descriptors) {
    if (!Object.hasOwn(values, descriptor.key)) continue
    const value = values[descriptor.key]
    if (descriptor.multiplicity === 'repeatable' && !Array.isArray(value)) {
      throw new UrlStateError(`"${descriptor.key}" is repeatable and expects an array of values`)
    }
    if (descriptor.multiplicity === 'single' && Array.isArray(value)) {
      throw new UrlStateError(`"${descriptor.key}" is single and expects one value, not an array`)
    }
    const list = descriptor.multiplicity === 'repeatable' ? value : [value]
    if (
      !includeDefaults &&
      descriptor.multiplicity === 'single' &&
      descriptor.hasDefault &&
      formatValue(descriptor, list[0]) === descriptor.defaultRaw
    ) {
      continue
    }
    for (const item of list) {
      const serialized = formatValue(descriptor, item)
      if (typeof serialized !== 'string') {
        throw new UrlStateError(`"${descriptor.key}" holds a value that cannot be serialized`)
      }
      chunks.push(`${encodeComponent(descriptor.key)}=${encodeComponent(serialized)}`)
    }
  }
  for (const pair of unknown) {
    chunks.push(`${encodeComponent(pair.key)}=${encodeComponent(pair.value)}`)
  }
  return chunks.join('&')
}

/**
 * Serialize a parsed state back into a URL string.
 * Declared keys are emitted in contract declaration order, then kept unknown
 * keys in the order they were first seen. Throws UrlStateError when a value
 * cannot be represented, rather than emitting a lossy replacement.
 */
export function serializeUrlState(contract, state, { includeDefaults = false } = {}) {
  if (state === null || typeof state !== 'object') throw new UrlStateError('state must be an object')
  const segments = Array.isArray(state.segments) ? state.segments : []
  const params = state.params ?? {}
  let path = ''
  if (contract.route !== null && contract.route.segments.length > 0) {
    const rendered = contract.route.segments.map((segment) => {
      if (!segment.startsWith(':')) return encodeComponent(segment)
      const name = segment.slice(1)
      if (!Object.hasOwn(params, name)) throw new UrlStateError(`route parameter "${name}" is missing`)
      const descriptor = contract.params.find((candidate) => candidate.key === name)
      const value = descriptor === undefined ? params[name] : formatValue(descriptor, params[name])
      if (typeof value !== 'string') throw new UrlStateError(`route parameter "${name}" is not serializable`)
      return encodeComponent(value)
    })
    path = '/' + rendered.join('/')
  } else {
    path = '/' + segments.map((segment) => encodeComponent(segment)).join('/')
  }

  const query = serializePairs(contract.query, state.query ?? {}, state.unknownQuery ?? [], includeDefaults)
  let out = `${state.origin ?? ''}${path}`
  if (query.length > 0) out += `?${query}`

  const hash = state.hash ?? null
  if (hash !== null) {
    if (hash.mode === 'opaque') out += `#${encodeComponent(hash.value)}`
    else {
      const rendered = serializePairs(contract.hash.params, hash.params ?? {}, hash.unknown ?? [], includeDefaults)
      if (rendered.length > 0) out += `#${rendered}`
    }
  }
  return out
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Value-only fingerprint of a state. Provenance bookkeeping (which keys came
 * from a declared default) is excluded on purpose: the round-trip guarantee is
 * about values, not about how they arrived.
 */
export function stateFingerprint(state) {
  if (state === null) return 'null'
  return canonical({
    origin: state.origin ?? '',
    segments: state.segments ?? [],
    params: state.params ?? {},
    query: state.query ?? {},
    unknownQuery: (state.unknownQuery ?? []).map((pair) => [pair.key, pair.value]),
    hash:
      state.hash === null || state.hash === undefined
        ? null
        : state.hash.mode === 'opaque'
          ? { mode: 'opaque', value: state.hash.value }
          : {
              mode: 'params',
              params: state.hash.params ?? {},
              unknown: (state.hash.unknown ?? []).map((pair) => [pair.key, pair.value])
            }
  })
}
