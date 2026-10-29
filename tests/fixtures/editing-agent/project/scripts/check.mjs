// The declared synthetic project command. It fails on the committed baseline and passes only
// after all three expected edits exist.
import { readFile } from 'node:fs/promises'

import { greet } from '../src/greeting.mjs'
import { add } from '../src/math.mjs'

const failures = []
if (add(2, 3) !== 5) failures.push('math')
if (greet('FlowProof') !== 'Hello, FlowProof!') failures.push('greeting')
if (!(await readFile(new URL('../README.md', import.meta.url), 'utf8')).includes('Status: edited')) failures.push('readme')

if (failures.length > 0) {
  console.error(`check failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('check passed')
