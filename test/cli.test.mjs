import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { parseFailureDetail } from '../src/index.mjs'

const run = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'bin', 'url-state-contract-checker.mjs')

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: ROOT })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

test('--help explains the tool and leaves stdout clean for a pipe', async () => {
  const result = await cli(['--help'])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, '', 'help never pollutes the JSON stream')
  assert.match(result.stderr, /--contract FILE/)
  assert.match(result.stderr, /Exit codes/)
})

test('the clean example passes with exit 0 and a parseable report on stdout', async () => {
  const result = await cli(['--contract', 'examples/contract.json', '--urls', 'examples/urls.clean.json'])
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'url-state-contract-checker')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.checked, 6)
  assert.equal(report.summary.roundTrips, 6)
  assert.match(result.stderr, /url-state-contract-checker: pass/)
  for (const finding of report.findings) {
    assert.equal(finding.location.file, 'examples/urls.clean.json')
    assert.equal(finding.location.file.startsWith('/'), false, 'no absolute host path leaks')
  }
})

test('the broken example fails with exit 1 and names every policy it broke', async () => {
  const result = await cli(['--contract', 'examples/contract.json', '--urls', 'examples/urls.broken.json'])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.checked, 12)
  const seen = new Set(report.findings.map((finding) => finding.ruleId))
  for (const ruleId of [
    'unknown-query-key',
    'repeated-single-key',
    'invalid-utf8-sequence',
    'malformed-percent-encoding',
    'invalid-enum-value',
    'integer-out-of-range',
    'invalid-boolean-value',
    'route-param-invalid',
    'missing-required-key',
    'bare-key-not-allowed',
    'charset-violation',
    'repeat-count-exceeded'
  ]) {
    assert.ok(seen.has(ruleId), `the broken example exercises ${ruleId}`)
  }
})

test('--json suppresses the human summary but keeps the report on stdout', async () => {
  const result = await cli(['--contract', 'examples/contract.json', '--urls', 'examples/urls.clean.json', '--json'])
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  assert.equal(JSON.parse(result.stdout).status, 'pass')
})

test('--url checks an inline URL without a fixture file', async () => {
  const pass = await cli([
    '--contract', 'examples/contract.json',
    '--url', '/catalog/tools/search?q=drill',
    '--json'
  ])
  assert.equal(pass.code, 0)
  assert.equal(JSON.parse(pass.stdout).summary.checked, 1)

  const fail = await cli([
    '--contract', 'examples/contract.json',
    '--url', '/catalog/tools/search?q=drill&utm_source=news',
    '--json'
  ])
  assert.equal(fail.code, 1)
  const failed = JSON.parse(fail.stdout)
  assert.equal(failed.status, 'fail')
  assert.ok(failed.findings.some((finding) => finding.ruleId === 'unknown-query-key'))
})

test('the same command twice produces byte-identical stdout', async () => {
  const args = ['--contract', 'examples/contract.json', '--urls', 'examples/urls.broken.json', '--json']
  const first = await cli(args)
  const second = await cli(args)
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, second.code)
  assert.ok(first.stdout.length > 0)
})

test('an unreadable input is incomplete with exit 2, never a pass', async () => {
  const missing = await cli(['--contract', 'examples/contract.json', '--urls', 'examples/nope.json', '--json'])
  assert.equal(missing.code, 2)
  const report = JSON.parse(missing.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings[0].ruleId, 'input-unreadable')
  assert.equal(report.findings[0].message.includes(ROOT), false, 'no absolute host path in the message')
})

test('an invalid contract is incomplete with exit 2 and lists what is wrong', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'url-state-contract-checker-'))
  try {
    const broken = join(directory, 'contract.json')
    await writeFile(broken, JSON.stringify({ query: { page: { type: 'integer', min: 'low' } } }), 'utf8')
    const result = await cli(['--contract', broken, '--url', '/a', '--json'])
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings[0].ruleId, 'contract-invalid')

    const malformed = join(directory, 'malformed.json')
    await writeFile(malformed, '{ not json', 'utf8')
    const second = await cli(['--contract', malformed, '--url', '/a', '--json'])
    assert.equal(second.code, 2)
    assert.equal(JSON.parse(second.stdout).findings[0].ruleId, 'input-unreadable')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('unknown usage is refused with exit 2 and nothing on stdout', async () => {
  for (const args of [[], ['--contract'], ['--nope'], ['--contract', 'examples/contract.json']]) {
    const result = await cli(args)
    assert.equal(result.code, 2, `refused: ${args.join(' ')}`)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Usage:/)
  }
})

test('an empty fixture is incomplete with exit 2, never a pass on zero evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'url-state-contract-checker-'))
  try {
    for (const [name, body] of [['array.json', '[]'], ['object.json', '{ "urls": [] }']]) {
      const fixture = join(directory, name)
      await writeFile(fixture, body, 'utf8')
      const result = await cli(['--contract', 'examples/contract.json', '--urls', fixture, '--json'])
      assert.equal(result.code, 2, `empty fixture ${name} is not a pass`)
      const report = JSON.parse(result.stdout)
      assert.equal(report.status, 'incomplete')
      assert.equal(report.summary.checked, 0)
      assert.equal(report.findings.length, 1)
      assert.equal(report.findings[0].ruleId, 'fixture-empty')
      assert.equal(report.findings[0].location.file, name)
    }

    const combined = join(directory, 'array.json')
    const withInline = await cli([
      '--contract', 'examples/contract.json',
      '--urls', combined,
      '--url', '/catalog/tools/search?q=drill',
      '--json'
    ])
    assert.equal(withInline.code, 0, 'an empty file plus an inline URL still has evidence')
    assert.equal(JSON.parse(withInline.stdout).summary.checked, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a load failure names the file that failed, not the other input', async () => {
  const missingContract = await cli([
    '--contract', 'examples/nope-contract.json',
    '--urls', 'examples/urls.clean.json',
    '--json'
  ])
  assert.equal(missingContract.code, 2)
  const first = JSON.parse(missingContract.stdout).findings[0]
  assert.equal(first.ruleId, 'input-unreadable')
  assert.match(first.message, /could not read contract/)
  assert.equal(first.location.file, 'examples/nope-contract.json')

  const inlineUrl = await cli(['--contract', 'examples/nope-contract.json', '--url', '/a', '--json'])
  assert.equal(inlineUrl.code, 2)
  assert.equal(JSON.parse(inlineUrl.stdout).findings[0].location.file, 'examples/nope-contract.json')

  const missingFixture = await cli([
    '--contract', 'examples/contract.json',
    '--urls', 'examples/nope-fixture.json',
    '--json'
  ])
  assert.equal(missingFixture.code, 2)
  const second = JSON.parse(missingFixture.stdout).findings[0]
  assert.match(second.message, /could not read fixture/)
  assert.equal(second.location.file, 'examples/nope-fixture.json')

  const directory = await mkdtemp(join(tmpdir(), 'url-state-contract-checker-'))
  try {
    const malformed = join(directory, 'malformed-contract.json')
    await writeFile(malformed, '{ not json', 'utf8')
    const result = await cli([
      '--contract', malformed,
      '--urls', 'examples/urls.clean.json',
      '--json'
    ])
    assert.equal(result.code, 2)
    const finding = JSON.parse(result.stdout).findings[0]
    assert.equal(finding.ruleId, 'input-unreadable')
    assert.equal(finding.location.file, 'malformed-contract.json')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('unsafe fixture basenames use unambiguous role provenance without raw controls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'url-state-label-'))
  try {
    const body = await readFile(join(ROOT, 'examples/urls.broken.json'))
    const safe = join(directory, 'badfixture.json')
    await writeFile(safe, body)
    const safeRun = await cli(['--contract', 'examples/contract.json', '--urls', safe, '--json'])
    assert.equal(safeRun.code, 1)
    assert.equal(JSON.parse(safeRun.stdout).findings[0].location.file, 'badfixture.json')
    for (const name of ['bad\u2028fixture.json', 'bad\u2029fixture.json', 'bad\u0001fixture.json', 'bad\u0085fixture.json', 'bad\u202efixture.json', '\u200e']) {
      const fixture = join(directory, name)
      await writeFile(fixture, body)
      const run = await cli(['--contract', 'examples/contract.json', '--urls', fixture, '--json'])
      assert.equal(run.code, 1)
      const report = JSON.parse(run.stdout)
      assert.equal(report.status, 'fail')
      assert.ok(report.findings.length > 0)
      assert.ok(report.findings.every(finding => finding.location.file === '@fixture'))
      assert.equal(run.stdout.includes(name), false)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('unsafe contract basename is attributed to the contract role even on read failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'url-state-label-'))
  try {
    const contract = join(directory, 'bad\u2028contract.json')
    const result = await cli(['--contract', contract, '--url', '/a', '--json'])
    assert.equal(result.code, 2)
    const finding = JSON.parse(result.stdout).findings[0]
    assert.equal(finding.location.file, '@contract')
    assert.equal(result.stdout.includes('bad\u2028contract'), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a fixture that is not a URL list is incomplete rather than empty-pass', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'url-state-contract-checker-'))
  try {
    const fixture = join(directory, 'fixture.json')
    await writeFile(fixture, JSON.stringify({ routes: ['/a'] }), 'utf8')
    const result = await cli(['--contract', 'examples/contract.json', '--urls', fixture, '--json'])
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings[0].ruleId, 'fixture-invalid')
    assert.equal(report.summary.checked, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/**
 * A document that will not parse must not be quoted back.
 *
 * V8 reports a parse failure two ways and one of them embeds the input:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`, or a
 * ten-character prefix followed by `"..."`. Both streams carry the message --
 * the JSON report on stdout and the human summary on stderr -- so a contract
 * or fixture short enough to be only a credential was published twice by its
 * own diagnostic. The canary is a published AWS documentation placeholder,
 * not a live key.
 */
const CANARY = 'AKIAIOSFODNN7EXAMPLE'

/** Every prefix down to eight characters, which is below V8's truncation at ten. */
function assertNoCanary(result) {
  for (const [name, stream] of [['stdout', result.stdout], ['stderr', result.stderr]]) {
    for (let length = CANARY.length; length >= 8; length -= 1) {
      assert.equal(
        stream.includes(CANARY.slice(0, length)),
        false,
        `${name} echoed the first ${length} characters of the unparseable document`
      )
    }
  }
}

test('an unparseable fixture is reported without echoing its contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'url-state-contract-checker-'))
  try {
    const fixture = join(directory, 'fixture.json')
    await writeFile(fixture, CANARY, 'utf8')
    const result = await cli(['--contract', 'examples/contract.json', '--urls', fixture])

    assert.equal(result.code, 2)
    assertNoCanary(result)
    const finding = JSON.parse(result.stdout).findings[0]
    assert.equal(finding.ruleId, 'input-unreadable')
    assert.equal(finding.message, "fixture is not valid JSON: unexpected token 'A' at the start of the document")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an unparseable contract is reported without echoing its contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'url-state-contract-checker-'))
  try {
    const contract = join(directory, 'contract.json')
    await writeFile(contract, CANARY, 'utf8')
    const result = await cli(['--contract', contract, '--urls', 'examples/urls.clean.json'])

    assert.equal(result.code, 2)
    assertNoCanary(result)
    assert.match(JSON.parse(result.stdout).findings[0].message, /contract is not valid JSON/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a truncated fixture still reports where parsing stopped', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'url-state-contract-checker-'))
  try {
    const fixture = join(directory, 'fixture.json')
    await writeFile(fixture, `{"urls": ["https://x.example/?token=${CANARY}" `, 'utf8')
    const result = await cli(['--contract', 'examples/contract.json', '--urls', fixture])

    assert.equal(result.code, 2)
    assertNoCanary(result)
    assert.match(
      JSON.parse(result.stdout).findings[0].message,
      /at position \d+ \(line \d+ column \d+\)$/,
      'the position, line and column are the useful half and must survive'
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('parseFailureDetail keeps the position and drops the quoted document', () => {
  const capture = (source) => {
    try {
      JSON.parse(source)
      return null
    } catch (error) {
      return error
    }
  }

  const quoting = capture(CANARY)
  assert.equal(quoting.message.includes(CANARY), true, 'V8 no longer quotes the input; this guard needs revisiting')
  assert.equal(parseFailureDetail(quoting), "unexpected token 'A' at the start of the document")

  // A longer document is quoted as a ten-character prefix, which a check for
  // the whole value would miss entirely.
  const truncated = capture('password=hunter2-correct-horse')
  assert.equal(truncated.message.includes('password=h'), true)
  assert.equal(parseFailureDetail(truncated), "unexpected token 'p' at the start of the document")

  // The token is one character of untrusted input, so it is redacted.
  const escape = capture(`${String.fromCharCode(0x1b)}[2J`)
  assert.equal(parseFailureDetail(escape), "unexpected token '\\u001b' at the start of the document")

  assert.match(parseFailureDetail(capture('{"a": 1, ')), /at position \d+ \(line \d+ column \d+\)$/)
  assert.equal(parseFailureDetail(capture('')), 'Unexpected end of JSON input')
  assert.equal(parseFailureDetail(new Error('unrecognised shape')), 'the document could not be parsed as JSON')
})
