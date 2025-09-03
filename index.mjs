#!/usr/bin/env node

import fs from 'fs'
import { rimrafSync } from "rimraf";
import path from 'path'
import codeExport from './browserstack-mocha-export.mjs'
import { project as projectProcessor } from '@seleniumhq/side-code-export'
import pkg from '@seleniumhq/side-utils';
import commander from 'commander';
import logger from 'cli-logger';
import { globSync } from 'glob';
import spawn from 'cross-spawn';
import * as dotenv from 'dotenv';
import { exit } from 'process';
import { fileURLToPath } from 'url';

dotenv.config();
commander
  .usage('[options] project.side [project.side] [*.side]')
  .option('-d, --debug', 'output extra debugging')
  .option('-f, --filter <grep regex>', 'Run tests matching name')
  .option('--base-url <url>', 'Override the base URL that was set in the IDE')
  .option('--test-timeout <ms>', 'Timeout value for each tests (default: 30000)')
  .option('--browserstack.config <path>', 'path to browserstack config file, default to browserstack.yml')
  .option('--output-format <json|xunit>', 'Format for the output file.')
  .option('--output-file <path>', 'path for the report file. required if --output-format provided')

commander.parse(process.argv);
const options = commander.opts();
options.testTimeout = options.testTimeout ? options.testTimeout : 30000
options.filter = options.filter ? options.filter : ''
options.browserstackConfig = options['browserstack.config'] ? options['browserstack.config'] : 'browserstack.yml'
options.buildFolderPath = '_generated'
var conf = { level: options.debug ? logger.DEBUG : logger.INFO };
var log = logger(conf);

const sideFiles = [
  ...commander.args.reduce((projects, project) => {
    globSync(project).forEach(p => {
      projects.add(p)
    })
    return projects
  }, new Set()),
];

rimrafSync(options.buildFolderPath)
fs.mkdirSync(options.buildFolderPath);

function readFile(filename) {
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('Invalid filename')
  }
  if (path.extname(filename) !== '.side') {
    throw new Error('Only .side files are allowed')
  }

  const cwd = process.cwd()
  const absolutePath = path.isAbsolute(filename)
    ? path.normalize(filename)
    : path.resolve(cwd, filename) // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — extension validated and path contained to cwd below

  // Containment check: ensure the resolved path is inside cwd
  const rel = path.relative(cwd, absolutePath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Access outside the working directory is not allowed')
  }

  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error('Target file does not exist or is not a regular file')
  }

  return JSON.parse(fs.readFileSync(absolutePath, 'utf8'))
}

function normalizeProject(project) {
  let _project = { ...project }
  _project.suites.forEach(suite => {
    projectProcessor.normalizeTestsInSuite({ suite, tests: _project.tests })
  })
  _project.url = options.baseUrl ? options.baseUrl : project.url
  return _project
}

for (const sideFileName of sideFiles) {
  const project = normalizeProject(readFile(sideFileName))
  for (const aSuite of project.suites) {
    for (const aTestCase of aSuite.tests) {
      const test = project.tests.find(test => test.name === aTestCase);
      var results = await codeExport.default.emit.test({
        baseUrl: options.baseUrl ? options.baseUrl : project.url,
        test: test,
        tests: project.tests,
        project: project
      })
      fs.writeFileSync(path.join(
        options.buildFolderPath,
        results.filename
      ), results.body);
    }
  }

}

var reporter = []
if (options.outputFormat && options.outputFile)
  reporter = ['--reporter', options.outputFormat, '--reporter-options', 'output=' + options.outputFile]

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sideRunnerNodeModules = path.join(__dirname, 'node_modules');

// Resolve BrowserStack SDK binary robustly with fallbacks
const sdkCandidates = [
  path.join(__dirname, 'node_modules', '.bin', 'browserstack-node-sdk'),
  path.join(process.cwd(), 'node_modules', '.bin', 'browserstack-node-sdk'),
  // Fall back to letting the OS PATH resolve it (e.g., project-level node_modules/.bin)
  'browserstack-node-sdk'
]
const sdkBin = sdkCandidates.find(p => {
  try {
    // If candidate is a bare command (no path separators), let it pass
    if (!p.includes(path.sep)) return true
    return fs.existsSync(p)
  } catch {
    return false
  }
}) || 'browserstack-node-sdk'

if (options.debug) {
  log.debug(`Using BrowserStack SDK binary: ${sdkBin}`)
}

let testSuiteProcess
try {
  testSuiteProcess = spawn.sync(
    sdkBin,
    ['mocha', '_generated', '--timeouts', String(options.testTimeout), '-g', options.filter, '--browserstack.config', options.browserstackConfig, ...reporter],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        testTimeout: options.testTimeout,
        NODE_PATH: `${sideRunnerNodeModules}${path.delimiter}${process.env.NODE_PATH || ''}`
      }
    }
  )
} catch (err) {
  log.error(`Failed to start BrowserStack SDK at "${sdkBin}": ${err.message}`)
  exit(1)
}

if (testSuiteProcess.error) {
  log.error(`Failed to start BrowserStack SDK at "${sdkBin}": ${testSuiteProcess.error.message}`)
  exit(1)
}

if (!options.debug) {
  rimrafSync(options.buildFolderPath)
}
exit(testSuiteProcess.status ?? 1)