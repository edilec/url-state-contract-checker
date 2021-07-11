#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, normalize, resolve, sep } from 'node:path'

import {
  ContractError,
  LIMITS,
  checkUrls,
  exitCodeFor,
  formatReport,
  parseBoundedJson,
  unreadableReport
} from '../src/index.mjs'

const HELP = `url-state-contract-checker

Check fixture URLs against a declared route, query and fragment contract:
schemas, defaults, multiplicity, unknown-key policy and serialization.

Usage:
  url-state-contract-checker --contract FILE (--urls FILE | --url URL)... [options]

Options:
  --contract FILE   Declared URL state contract (JSON)
  --urls FILE       Fixture file: a JSON array of URLs, or { "urls": [ ... ] }
  --url URL         A single URL to check; may be repeated, and combines
                    with --urls
  --timeout-ms N    Wall budget across all URLs (default ${LIMITS.defaultTimeoutMs})
  --json            Machine mode: suppress the human summary on stderr
  -h, --help        Show this help

Streams:
  stdout  the JSON report and nothing else, so it can be piped to a parser
  stderr  the human summary and any usage diagnostics

Exit codes:
  0  every URL satisfied the contract
  1  the contract was evaluated and at least one URL failed it
  2  invalid usage or contract, unreadable input, or a limit was exceeded
     (status "incomplete" - never reported as a pass)
`

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { contract: null, urls: null, inline: [], json: false, timeoutMs: null }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--contract') options.contract = takeValue('--contract')
    else if (argument === '--urls') options.urls = takeValue('--urls')
    else if (argument === '--url') options.inline.push(takeValue('--url'))
    else if (argument === '--timeout-ms') {
      const raw = Number(takeValue('--timeout-ms'))
      if (!Number.isSafeInteger(raw) || raw <= 0) throw new Error('--timeout-ms must be a positive integer')
      options.timeoutMs = raw
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.contract === null) throw new Error('--contract is required')
  if (options.urls === null && options.inline.length === 0) {
    throw new Error('at least one of --urls or --url is required')
  }
  return options
}

// location.file must stay input-relative: an absolute path on this host would
// leak the machine layout into a report meant to be compared across machines.
function inputLabel(path) {
  if (path === null) return 'inline'
  if (isAbsolute(path)) return basename(path)
  const relative = normalize(path)
  if (relative.startsWith(`..${sep}`) || relative === '..') return basename(path)
  return relative.split(sep).join('/')
}

async function loadJson(path, label) {
  let text
  try {
    text = await readFile(resolve(path), 'utf8')
  } catch (error) {
    throw new ContractError([`could not read ${label} at ${basename(path)}: ${error.code ?? error.message}`])
  }
  return parseBoundedJson(text, label)
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stderr.write(HELP)
    return 0
  }

  const file = inputLabel(options.urls)
  let report
  try {
    const contract = await loadJson(options.contract, 'contract')
    const urls = []
    if (options.urls !== null) {
      const fixture = await loadJson(options.urls, 'fixture')
      const entries = Array.isArray(fixture) ? fixture : fixture?.urls
      if (!Array.isArray(entries)) {
        report = checkUrls(contract, fixture, { sourceFile: file })
      } else {
        urls.push(...entries)
      }
    }
    if (report === undefined) {
      urls.push(...options.inline)
      report = checkUrls(contract, urls, {
        sourceFile: file,
        timeoutMs: options.timeoutMs ?? undefined
      })
    }
  } catch (error) {
    if (!(error instanceof ContractError)) throw error
    report = unreadableReport(error.problems.join('; '), file)
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!options.json) process.stderr.write(formatReport(report))
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
