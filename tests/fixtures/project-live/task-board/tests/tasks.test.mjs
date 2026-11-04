import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SEED_TASKS, countOpen, formatSummary, toggleTask } from '../src/tasks.js'

test('formatSummary pluralizes the open-task count', () => {
  assert.equal(formatSummary(0), '0 open tasks')
  assert.equal(formatSummary(1), '1 open task')
  assert.equal(formatSummary(3), '3 open tasks')
})

test('countOpen counts unfinished tasks', () => {
  assert.equal(countOpen(SEED_TASKS), 3)
  assert.equal(countOpen([]), 0)
})

test('toggleTask flips one task without mutating the input', () => {
  const toggled = toggleTask(SEED_TASKS, 'task-2')
  assert.equal(toggled.find((task) => task.id === 'task-2').done, true)
  assert.equal(SEED_TASKS.find((task) => task.id === 'task-2').done, false)
  assert.equal(countOpen(toggled), 2)
})
