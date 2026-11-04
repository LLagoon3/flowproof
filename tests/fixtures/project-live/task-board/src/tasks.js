// Synthetic sample data for the FlowProof project-live fixture. No real people or accounts.
export const SEED_TASKS = Object.freeze([
  Object.freeze({ id: 'task-1', title: 'Draft release notes', done: true }),
  Object.freeze({ id: 'task-2', title: 'Review sample data', done: false }),
  Object.freeze({ id: 'task-3', title: 'Update onboarding checklist', done: true }),
  Object.freeze({ id: 'task-4', title: 'Prepare demo script', done: false }),
  Object.freeze({ id: 'task-5', title: 'Archive old tickets', done: false }),
])

export const FILTERS = Object.freeze([
  Object.freeze({ value: 'all', label: 'All tasks' }),
  Object.freeze({ value: 'open', label: 'Open' }),
  Object.freeze({ value: 'done', label: 'Done' }),
])

export function countOpen(tasks) {
  return tasks.filter((task) => !task.done).length
}

export function formatSummary(openCount) {
  return openCount === 1 ? '1 open task' : `${openCount} open tasks`
}

export function toggleTask(tasks, id) {
  return tasks.map((task) => (task.id === id ? { ...task, done: !task.done } : task))
}
