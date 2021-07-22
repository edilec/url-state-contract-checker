import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

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
