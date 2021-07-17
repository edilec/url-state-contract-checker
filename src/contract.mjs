// Contract normalization, declared limits and single-value coercion.
//
// Everything in this file is pure: the same contract object always normalizes
// to the same shape, and the same raw string always coerces to the same value.

export const LIMITS = Object.freeze({
  maxInputBytes: 1048576,
  maxJsonDepth: 20,
  maxUrls: 1000,
  maxUrlLength: 8192,
  maxQueryPairs: 256,
  maxKeyLength: 256,
  maxValueLength: 4096,
  maxContractKeys: 256,
  maxRepeatCount: 64,
  maxPathSegments: 64,
  maxEvidenceLength: 80,
  defaultTimeoutMs: 10000
})

const UNKNOWN_POLICIES = ['error', 'warn', 'keep', 'drop']
const REPEAT_POLICIES = ['error', 'first', 'last']
const TYPES = ['string', 'integer', 'boolean', 'enum']
const MULTIPLICITIES = ['single', 'repeatable']
const HASH_MODES = ['none', 'opaque', 'params']
const CHARSETS = ['any', 'digits', 'hex', 'alnum', 'slug']

export class ContractError extends Error {
  constructor(problems) {
    const list = Array.isArray(problems) ? problems : [String(problems)]
    super(list.join('; '))
    this.name = 'ContractError'
    this.problems = list.slice()
  }
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Iterative depth walk. A deeply nested literal never reaches the recursion
// limit of the engine because this refuses it first.
export function assertJsonDepth(value, maxDepth, label) {
  const stack = [[value, 1]]
  while (stack.length > 0) {
    const [node, depth] = stack.pop()
    if (depth > maxDepth) {
      throw new ContractError([`${label} nests deeper than the ${maxDepth}-level limit`])
    }
    if (Array.isArray(node)) {
      for (const item of node) stack.push([item, depth + 1])
    } else if (isPlainObject(node)) {
      for (const key of Object.keys(node)) stack.push([node[key], depth + 1])
    }
  }
}

function enumOption(raw, allowed, fallback, path, problems) {
  if (raw === undefined) return fallback
  if (typeof raw !== 'string' || !allowed.includes(raw)) {
    problems.push(`${path} must be one of ${allowed.join(', ')}`)
    return fallback
  }
  return raw
}

function boundedInteger(raw, path, problems, { min, max, fallback }) {
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max) {
    problems.push(`${path} must be an integer between ${min} and ${max}`)
    return fallback
  }
  return raw
}

const CHARSET_TESTS = {
  any: () => true,
  digits: (code) => code >= 0x30 && code <= 0x39,
  hex: (code) =>
    (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66),
  alnum: (code) =>
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a),
  slug: (code) =>
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x2d ||
    code === 0x5f
}

function violatesCharset(value, charset) {
  if (charset === 'any') return false
  const test = CHARSET_TESTS[charset]
  for (let index = 0; index < value.length; index += 1) {
    if (!test(value.charCodeAt(index))) return true
  }
  return false
}

function parseDecimalInteger(raw) {
  if (raw.length === 0 || raw.length > 19) return null
  let start = 0
  let sign = 1
  if (raw[0] === '-') {
    sign = -1
    start = 1
  } else if (raw[0] === '+') {
    return null
  }
  if (start === raw.length) return null
  let total = 0
  for (let index = start; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    if (code < 0x30 || code > 0x39) return null
    total = total * 10 + (code - 0x30)
  }
  if (!Number.isSafeInteger(total)) return null
  return sign * total
}

function normalizeDescriptor(key, raw, path, problems, { allowPresence }) {
  if (!isPlainObject(raw)) {
    problems.push(`${path} must be an object`)
    return null
  }
  const known = allowPresence
    ? [
        'type', 'values', 'multiplicity', 'required', 'default', 'min', 'max',
        'minLength', 'maxLength', 'charset', 'emptyAllowed', 'maxCount', 'description'
      ]
    : ['type', 'values', 'min', 'max', 'minLength', 'maxLength', 'charset', 'description']
  for (const field of Object.keys(raw)) {
    if (!known.includes(field)) problems.push(`${path}.${field} is not a recognized field`)
  }

  const descriptor = {
    key,
    type: enumOption(raw.type, TYPES, 'string', `${path}.type`, problems),
    values: null,
    multiplicity: allowPresence
      ? enumOption(raw.multiplicity, MULTIPLICITIES, 'single', `${path}.multiplicity`, problems)
      : 'single',
    required: false,
    hasDefault: false,
    defaultRaw: null,
    defaultValue: null,
    min: null,
    max: null,
    minLength: null,
    maxLength: null,
    charset: enumOption(raw.charset, CHARSETS, 'any', `${path}.charset`, problems),
    emptyAllowed: false,
    maxCount: 16
  }

  if (descriptor.type === 'enum') {
    if (!Array.isArray(raw.values) || raw.values.length === 0) {
      problems.push(`${path}.values must be a non-empty array for an enum`)
    } else if (raw.values.length > LIMITS.maxContractKeys) {
      problems.push(`${path}.values declares more than ${LIMITS.maxContractKeys} members`)
    } else if (raw.values.some((member) => typeof member !== 'string')) {
      problems.push(`${path}.values must contain strings only`)
    } else {
      descriptor.values = raw.values.slice()
    }
  } else if (raw.values !== undefined) {
    problems.push(`${path}.values is only meaningful for an enum`)
  }

  if (descriptor.type === 'integer') {
    descriptor.min = boundedInteger(raw.min, `${path}.min`, problems, {
      min: Number.MIN_SAFE_INTEGER,
      max: Number.MAX_SAFE_INTEGER,
      fallback: null
    })
    descriptor.max = boundedInteger(raw.max, `${path}.max`, problems, {
      min: Number.MIN_SAFE_INTEGER,
      max: Number.MAX_SAFE_INTEGER,
      fallback: null
    })
    if (descriptor.min !== null && descriptor.max !== null && descriptor.min > descriptor.max) {
      problems.push(`${path}.min is greater than ${path}.max`)
    }
  } else if (raw.min !== undefined || raw.max !== undefined) {
    problems.push(`${path}.min and ${path}.max are only meaningful for an integer`)
  }

  if (descriptor.type === 'string') {
    descriptor.minLength = boundedInteger(raw.minLength, `${path}.minLength`, problems, {
      min: 0,
      max: LIMITS.maxValueLength,
      fallback: null
    })
    descriptor.maxLength = boundedInteger(raw.maxLength, `${path}.maxLength`, problems, {
      min: 0,
      max: LIMITS.maxValueLength,
      fallback: null
    })
    if (
      descriptor.minLength !== null &&
      descriptor.maxLength !== null &&
      descriptor.minLength > descriptor.maxLength
    ) {
      problems.push(`${path}.minLength is greater than ${path}.maxLength`)
    }
  } else if (raw.minLength !== undefined || raw.maxLength !== undefined) {
    problems.push(`${path}.minLength and ${path}.maxLength are only meaningful for a string`)
  }

  if (allowPresence) {
    if (raw.required !== undefined) {
      if (typeof raw.required !== 'boolean') problems.push(`${path}.required must be a boolean`)
      else descriptor.required = raw.required
    }
    if (raw.emptyAllowed !== undefined) {
      if (typeof raw.emptyAllowed !== 'boolean') problems.push(`${path}.emptyAllowed must be a boolean`)
      else descriptor.emptyAllowed = raw.emptyAllowed
    }
    descriptor.maxCount = boundedInteger(raw.maxCount, `${path}.maxCount`, problems, {
      min: 1,
      max: LIMITS.maxRepeatCount,
      fallback: descriptor.multiplicity === 'repeatable' ? 16 : 1
    })
    if (descriptor.multiplicity === 'single') descriptor.maxCount = 1
    if (raw.default !== undefined) {
      if (typeof raw.default !== 'string') {
        problems.push(`${path}.default must be a string in its serialized form`)
      } else if (descriptor.required) {
        problems.push(`${path} cannot be both required and defaulted`)
      } else {
        descriptor.hasDefault = true
        descriptor.defaultRaw = raw.default
      }
    }
  }

  return descriptor
}

// Turn one already percent-decoded string into its typed value.
// Returns { ok: true, value } or { ok: false, ruleId, message }.
export function coerceValue(descriptor, raw) {
  if (raw.length > LIMITS.maxValueLength) {
    return {
      ok: false,
      ruleId: 'input-limit-exceeded',
      message: `value is longer than the ${LIMITS.maxValueLength}-character tool limit`
    }
  }
  if (raw.length === 0 && !descriptor.emptyAllowed) {
    return {
      ok: false,
      ruleId: 'empty-value-not-allowed',
      message: `"${descriptor.key}" does not permit an empty value`
    }
  }
  if (violatesCharset(raw, descriptor.charset)) {
    return {
      ok: false,
      ruleId: 'charset-violation',
      message: `"${descriptor.key}" permits only ${descriptor.charset} characters`
    }
  }
  if (descriptor.type === 'integer') {
    const parsed = parseDecimalInteger(raw)
    if (parsed === null) {
      return {
        ok: false,
        ruleId: 'invalid-integer-value',
        message: `"${descriptor.key}" expects a decimal integer`
      }
    }
    if (descriptor.min !== null && parsed < descriptor.min) {
      return {
        ok: false,
        ruleId: 'integer-out-of-range',
        message: `"${descriptor.key}" is below the declared minimum ${descriptor.min}`
      }
    }
    if (descriptor.max !== null && parsed > descriptor.max) {
      return {
        ok: false,
        ruleId: 'integer-out-of-range',
        message: `"${descriptor.key}" is above the declared maximum ${descriptor.max}`
      }
    }
    return { ok: true, value: parsed }
  }
  if (descriptor.type === 'boolean') {
    if (raw === 'true') return { ok: true, value: true }
    if (raw === 'false') return { ok: true, value: false }
    return {
      ok: false,
      ruleId: 'invalid-boolean-value',
      message: `"${descriptor.key}" expects exactly "true" or "false"`
    }
  }
  if (descriptor.type === 'enum') {
    if (descriptor.values !== null && !descriptor.values.includes(raw)) {
      return {
        ok: false,
        ruleId: 'invalid-enum-value',
        message: `"${descriptor.key}" is not one of ${descriptor.values.join(', ')}`
      }
    }
    return { ok: true, value: raw }
  }
  if (descriptor.minLength !== null && raw.length < descriptor.minLength) {
    return {
      ok: false,
      ruleId: 'value-length-out-of-range',
      message: `"${descriptor.key}" is shorter than the declared minimum ${descriptor.minLength}`
    }
  }
  if (descriptor.maxLength !== null && raw.length > descriptor.maxLength) {
    return {
      ok: false,
      ruleId: 'value-length-out-of-range',
      message: `"${descriptor.key}" is longer than the declared maximum ${descriptor.maxLength}`
    }
  }
  return { ok: true, value: raw }
}

// Render a typed value back into its canonical serialized string.
export function formatValue(descriptor, value) {
  if (descriptor.type === 'integer') return String(value)
  if (descriptor.type === 'boolean') return value ? 'true' : 'false'
  return value
}

function normalizeDescriptorMap(rawMap, path, problems, options) {
  const descriptors = []
  if (rawMap === undefined) return descriptors
  if (!isPlainObject(rawMap)) {
    problems.push(`${path} must be an object`)
    return descriptors
  }
  const keys = Object.keys(rawMap)
  if (keys.length > LIMITS.maxContractKeys) {
    problems.push(`${path} declares more than ${LIMITS.maxContractKeys} keys`)
    return descriptors
  }
  for (const key of keys) {
    if (key.length === 0 || key.length > LIMITS.maxKeyLength) {
      problems.push(`${path}."${key}" is not a usable key name`)
      continue
    }
    const descriptor = normalizeDescriptor(key, rawMap[key], `${path}.${key}`, problems, options)
    if (descriptor !== null) descriptors.push(descriptor)
  }
  return descriptors
}

function normalizeRoute(raw, problems) {
  if (raw === undefined) return null
  if (typeof raw !== 'string') {
    problems.push('route must be a string path pattern')
    return null
  }
  if (!raw.startsWith('/')) {
    problems.push('route must start with "/"')
    return null
  }
  const segments = raw.split('/').slice(1)
  if (segments.length > LIMITS.maxPathSegments) {
    problems.push(`route declares more than ${LIMITS.maxPathSegments} segments`)
    return null
  }
  const names = []
  for (const segment of segments) {
    if (!segment.startsWith(':')) continue
    const name = segment.slice(1)
    if (name.length === 0) problems.push('route declares an unnamed ":" parameter')
    else if (names.includes(name)) problems.push(`route declares the parameter "${name}" twice`)
    else names.push(name)
  }
  return { pattern: raw, segments, names }
}

/**
 * Validate and normalize a URL state contract.
 * Throws ContractError listing every problem found, so a broken contract is
 * reported once rather than one message at a time.
 */
export function normalizeContract(raw) {
  const problems = []
  if (!isPlainObject(raw)) throw new ContractError(['contract must be a JSON object'])
  assertJsonDepth(raw, LIMITS.maxJsonDepth, 'contract')

  const known = ['name', 'route', 'params', 'query', 'unknownQueryKeys', 'repeatedSingleKeys', 'hash', 'description']
  for (const field of Object.keys(raw)) {
    if (!known.includes(field)) problems.push(`${field} is not a recognized contract field`)
  }

  const name = typeof raw.name === 'string' ? raw.name : 'url-state-contract'
  if (raw.name !== undefined && typeof raw.name !== 'string') problems.push('name must be a string')

  const route = normalizeRoute(raw.route, problems)
  const params = normalizeDescriptorMap(raw.params, 'params', problems, { allowPresence: false })
  if (route !== null) {
    for (const descriptor of params) {
      if (!route.names.includes(descriptor.key)) {
        problems.push(`params.${descriptor.key} is not a parameter of the declared route`)
      }
    }
  } else if (params.length > 0) {
    problems.push('params requires a declared route')
  }

  const query = normalizeDescriptorMap(raw.query, 'query', problems, { allowPresence: true })
  const unknownQueryKeys = enumOption(
    raw.unknownQueryKeys, UNKNOWN_POLICIES, 'error', 'unknownQueryKeys', problems
  )
  const repeatedSingleKeys = enumOption(
    raw.repeatedSingleKeys, REPEAT_POLICIES, 'error', 'repeatedSingleKeys', problems
  )

  let hash = { mode: 'none', params: [], unknownKeys: 'error', maxLength: LIMITS.maxValueLength }
  if (raw.hash !== undefined) {
    if (!isPlainObject(raw.hash)) {
      problems.push('hash must be an object')
    } else {
      for (const field of Object.keys(raw.hash)) {
        if (!['mode', 'params', 'unknownKeys', 'maxLength', 'description'].includes(field)) {
          problems.push(`hash.${field} is not a recognized field`)
        }
      }
      const mode = enumOption(raw.hash.mode, HASH_MODES, 'none', 'hash.mode', problems)
      hash = {
        mode,
        params: normalizeDescriptorMap(raw.hash.params, 'hash.params', problems, { allowPresence: true }),
        unknownKeys: enumOption(raw.hash.unknownKeys, UNKNOWN_POLICIES, 'error', 'hash.unknownKeys', problems),
        maxLength: boundedInteger(raw.hash.maxLength, 'hash.maxLength', problems, {
          min: 0,
          max: LIMITS.maxValueLength,
          fallback: LIMITS.maxValueLength
        })
      }
      if (mode !== 'params' && hash.params.length > 0) {
        problems.push('hash.params requires hash.mode "params"')
      }
    }
  }

  const contract = { name, route, params, query, unknownQueryKeys, repeatedSingleKeys, hash }

  // A default that its own descriptor would reject is a contract bug, not a
  // finding about some URL, so it fails here.
  for (const descriptor of [...query, ...hash.params]) {
    if (!descriptor.hasDefault) continue
    const coerced = coerceValue(descriptor, descriptor.defaultRaw)
    if (!coerced.ok) problems.push(`default for "${descriptor.key}" is rejected by its own rules: ${coerced.message}`)
    else descriptor.defaultValue = coerced.value
  }

  if (problems.length > 0) throw new ContractError(problems)
  return contract
}
