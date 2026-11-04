import React, { useState } from 'react'

import { FILTERS, SEED_TASKS, countOpen, formatSummary, toggleTask } from './tasks.js'

function isVisible(task, filter) {
  if (filter === 'open') return task.done
  if (filter === 'done') return task.done
  return true
}

export default function App() {
  const [tasks, setTasks] = useState(SEED_TASKS)
  const [filter, setFilter] = useState('all')
  const visible = tasks.filter((task) => isVisible(task, filter))

  return (
    <main>
      <h1>Task board</h1>
      <label>
        Show{' '}
        <select data-testid="task-filter" value={filter} onChange={(event) => setFilter(event.target.value)}>
          {FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <p data-testid="task-summary">{formatSummary(countOpen(tasks))}</p>
      <ul data-testid="task-list">
        {visible.map((task) => (
          <li key={task.id} data-testid="task-item" data-task-id={task.id} data-done={String(task.done)}>
            <label>
              <input type="checkbox" checked={task.done} onChange={() => setTasks(toggleTask(tasks, task.id))} /> {task.title}
            </label>
          </li>
        ))}
      </ul>
      {visible.length === 0 ? <p data-testid="task-empty">No tasks to show.</p> : null}
    </main>
  )
}
