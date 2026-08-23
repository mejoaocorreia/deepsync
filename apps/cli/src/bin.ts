#!/usr/bin/env node
import { help, VERSION } from './index.ts'

const args = process.argv.slice(2)
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  process.stdout.write(help())
} else if (args.includes('--version') || args.includes('-V')) {
  process.stdout.write(`${VERSION}\n`)
} else {
  process.stderr.write(`deepsync: unknown command ${JSON.stringify(args[0])}\n`)
  process.exitCode = 2
}
