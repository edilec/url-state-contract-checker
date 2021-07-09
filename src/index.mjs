// Public API: normalize a contract, parse and serialize URL state, and check a
// fixture set of URLs into a report-contract v1 envelope.

import {
  ContractError,
  LIMITS,
  assertJsonDepth,
  coerceValue,
  formatValue,
  isPlainObject,
  normalizeContract
} from './contract.mjs'
import {
  UrlStateError,
  decodeComponent,
  encodeComponent,
  parseUrlState,
  serializeUrlState,
  splitUrl,
  stateFingerprint
} from './url-state.mjs'

export {
  ContractError,
  LIMITS,
  UrlStateError,
  coerceValue,
  decodeComponent,
  encodeComponent,
  formatValue,
  normalizeContract,
  parseUrlState,
  serializeUrlState,
  splitUrl,
  stateFingerprint
}

export const TOOL_ID = 'url-state-contract-checker'
export const SCHEMA_VERSION = '1'

// A finding with one of these ruleIds means the tool could not finish judging
// its input, so the report is "incomplete" and the CLI exits 2 - never 0.
export const INCOMPLETE_RULES = Object.freeze([
  'contract-invalid',
  'fixture-invalid',
  'input-limit-exceeded',
  'input-unreadable',
  'query-pair-limit-exceeded',
  'time-limit-exceeded',
  'url-limit-exceeded',
  'url-too-long'
])

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function defaultClock() {
  return Number(process.hrtime.bigint() / 1000000n)
}

function emit(collector, urlIndex, file, finding) {
  const record = {
    ruleId: finding.ruleId,
    severity: finding.severity,
    message: finding.message,
    location: {}
  }
  if (file !== null) record.location.file = file
  if (finding.pointer !== null && finding.pointer !== undefined) {
    record.location.pointer = urlIndex >= 0 ? `/urls/${urlIndex}${finding.pointer}` : finding.pointer
  }
  if (finding.evidence !== undefined) record.evidence = finding.evidence
  if (finding.suggestion !== undefined && finding.suggestion !== null) record.suggestion = finding.suggestion
  collector.push({ sortIndex: urlIndex, record })
}

function sortFindings(collected) {
  const decorated = collected.map((item, position) => ({ ...item, position }))
  decorated.sort((a, b) => {
    const left = a.record
    const right = b.record
    return (
      compare(left.location.file ?? '', right.location.file ?? '') ||
      a.sortIndex - b.sortIndex ||
      compare(left.location.pointer ?? '', right.location.pointer ?? '') ||
      compare(left.ruleId, right.ruleId) ||
      compare(left.message, right.message) ||
      compare(left.evidence ?? '', right.evidence ?? '') ||
      a.position - b.position
    )
  })
  return decorated.map((item) => item.record)
}

function buildReport(collected, counts) {
  const findings = sortFindings(collected)
  let errors = 0
  let warnings = 0
  let info = 0
  let incomplete = false
  for (const record of findings) {
    if (record.severity === 'error') errors += 1
    else if (record.severity === 'warning') warnings += 1
    else info += 1
    if (INCOMPLETE_RULES.includes(record.ruleId)) incomplete = true
  }
  const status = incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: counts.checked,
      errors,
      warnings,
      info,
      roundTrips: counts.roundTrips
    },
    findings
  }
}

function normalizeFixture(fixture, file, collected) {
  let entries = null
  if (Array.isArray(fixture)) entries = fixture
  else if (isPlainObject(fixture) && Array.isArray(fixture.urls)) entries = fixture.urls
  if (entries === null) {
    emit(collected, -1, file, {
      ruleId: 'fixture-invalid',
      severity: 'error',
      message: 'fixture must be an array of URLs or an object with a "urls" array',
      pointer: '/urls'
    })
    return null
  }
  if (entries.length > LIMITS.maxUrls) {
    emit(collected, -1, file, {
      ruleId: 'url-limit-exceeded',
      severity: 'error',
      message: `fixture holds ${entries.length} URLs, above the ${LIMITS.maxUrls} limit`,
      pointer: '/urls',
      suggestion: 'split the fixture into smaller files'
    })
    return null
  }
  const normalized = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (typeof entry === 'string') {
      normalized.push({ url: entry, id: null })
      continue
    }
    if (isPlainObject(entry) && typeof entry.url === 'string') {
      normalized.push({ url: entry.url, id: typeof entry.id === 'string' ? entry.id : null })
      continue
    }
    emit(collected, index, file, {
      ruleId: 'fixture-invalid',
      severity: 'error',
      message: 'entry must be a URL string or an object carrying a "url" string',
      pointer: ''
    })
    normalized.push(null)
  }
  return normalized
}

/**
 * Check every URL in a fixture against a contract.
 *
 * Never throws for bad input: a contract or fixture it cannot use produces a
 * report with status "incomplete". Options:
 *   sourceFile      label used for location.file; must be input-relative
 *   timeoutMs       wall budget across all URLs (default LIMITS.defaultTimeoutMs)
 *   clock           injected monotonic millisecond reader, for determinism
 *   includeDefaults also round-trip the default-including serialization
 */
export function checkUrls(rawContract, fixture, options = {}) {
  const file = typeof options.sourceFile === 'string' ? options.sourceFile : 'urls.json'
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : LIMITS.defaultTimeoutMs
  const clock = typeof options.clock === 'function' ? options.clock : defaultClock
  const collected = []

  let contract
  try {
    contract = normalizeContract(rawContract)
  } catch (error) {
    if (!(error instanceof ContractError)) throw error
    for (const problem of error.problems) {
      emit(collected, -1, null, {
        ruleId: 'contract-invalid',
        severity: 'error',
        message: problem,
        pointer: '/contract'
      })
    }
    return buildReport(collected, { checked: 0, roundTrips: 0 })
  }

  const entries = normalizeFixture(fixture, file, collected)
  if (entries === null) return buildReport(collected, { checked: 0, roundTrips: 0 })

  const started = clock()
  let checked = 0
  let roundTrips = 0

  for (let index = 0; index < entries.length; index += 1) {
    if (clock() - started > timeoutMs) {
      emit(collected, index, file, {
        ruleId: 'time-limit-exceeded',
        severity: 'error',
        message: `checking stopped at URL ${index} after the ${timeoutMs}ms budget`,
        pointer: '',
        suggestion: 'raise --timeout-ms or split the fixture'
      })
      break
    }
    const entry = entries[index]
    if (entry === null) continue
    checked += 1

    const parsed = parseUrlState(contract, entry.url)
    for (const item of parsed.findings) emit(collected, index, file, item)

    const blocking = parsed.findings.some((item) => item.severity === 'error')
    if (parsed.state === null || blocking) continue

    const mismatch = roundTripProblem(contract, parsed.state)
    if (mismatch === null) roundTrips += 1
    else {
      emit(collected, index, file, {
        ruleId: 'round-trip-mismatch',
        severity: 'error',
        message: mismatch.message,
        pointer: '',
        evidence: mismatch.evidence,
        suggestion: 'a permitted value is being lost by serialization; report it with this URL'
      })
    }
  }

  return buildReport(collected, { checked, roundTrips })
}

// parse -> serialize -> parse must return the same values, both when declared
// defaults are omitted and when they are written out.
function roundTripProblem(contract, state) {
  const expected = stateFingerprint(state)
  for (const includeDefaults of [false, true]) {
    let serialized
    try {
      serialized = serializeUrlState(contract, state, { includeDefaults })
    } catch (error) {
      if (!(error instanceof UrlStateError)) throw error
      return { message: `state could not be serialized: ${error.message}`, evidence: undefined }
    }
    const again = parseUrlState(contract, serialized)
    if (again.state === null || stateFingerprint(again.state) !== expected) {
      return {
        message: `re-parsing the serialized URL did not reproduce the same state (includeDefaults=${includeDefaults})`,
        evidence: serialized.slice(0, LIMITS.maxEvidenceLength)
      }
    }
  }
  return null
}

/** Build the report for a contract or fixture that could not be read at all. */
export function unreadableReport(message, file) {
  const collected = []
  emit(collected, -1, file ?? null, {
    ruleId: 'input-unreadable',
    severity: 'error',
    message,
    pointer: '/input',
    suggestion: 'check the path and that the file holds valid JSON'
  })
  return buildReport(collected, { checked: 0, roundTrips: 0 })
}

/** Parse JSON with the declared byte and depth bounds applied. */
export function parseBoundedJson(text, label) {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > LIMITS.maxInputBytes) {
    throw new ContractError([`${label} is ${bytes} bytes, above the ${LIMITS.maxInputBytes}-byte limit`])
  }
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new ContractError([`${label} is not valid JSON: ${error.message}`])
  }
  assertJsonDepth(value, LIMITS.maxJsonDepth, label)
  return value
}

const SEVERITY_WIDTH = 7

/** Human-readable summary. The CLI writes this to stderr, never to stdout. */
export function formatReport(report) {
  const lines = [`${report.tool}: ${report.status}`]
  lines.push(
    `  checked ${report.summary.checked} url(s), ` +
    `${report.summary.errors} error(s), ${report.summary.warnings} warning(s), ` +
    `${report.summary.roundTrips} verified round trip(s)`
  )
  for (const record of report.findings) {
    const where = record.location.pointer ?? record.location.file ?? '-'
    lines.push(`  ${record.severity.padEnd(SEVERITY_WIDTH)} ${record.ruleId}  ${where}`)
    lines.push(`          ${record.message}`)
    if (record.evidence !== undefined) lines.push(`          evidence: ${record.evidence}`)
  }
  return `${lines.join('\n')}\n`
}

/** Map a report status onto the documented process exit code. */
export function exitCodeFor(report) {
  if (report.status === 'pass') return 0
  if (report.status === 'fail') return 1
  return 2
}
