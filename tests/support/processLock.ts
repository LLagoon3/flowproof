import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Cross-process mutual exclusion for test resources that cannot be shared: the demo app's
// committed fixed `localhost` port and the canonical engine build output. Vitest runs test
// files in parallel workers and the Playwright suite may run beside it, so an in-memory
// lock is not enough. The lock is an atomically created directory that records its owner
// PID; a lock whose owner process no longer exists is reclaimed.

// Resolved once, so a suite that redirects TMPDIR for the code under test keeps the same lock.
const LOCK_ROOT = tmpdir()
const POLL_MS = 100

export interface ProcessLock {
  release(): Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function ownerOf(lockDir: string): Promise<number | null> {
  try {
    const pid = Number((await readFile(path.join(lockDir, 'owner'), 'utf8')).trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export async function acquireProcessLock(name: string, timeoutMs = 240_000): Promise<ProcessLock> {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid test lock name ${name}.`)
  const lockDir = path.join(LOCK_ROOT, `flowproof-test-lock-${name}`)
  const deadline = Date.now() + timeoutMs
  let ownerless = 0
  for (;;) {
    try {
      await mkdir(lockDir)
      await writeFile(path.join(lockDir, 'owner'), String(process.pid))
      let released = false
      return {
        async release() {
          if (released) return
          released = true
          await rm(lockDir, { recursive: true, force: true })
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const owner = await ownerOf(lockDir)
    // A missing owner file is a holder between mkdir and write; reclaim it only if it persists.
    ownerless = owner === null ? ownerless + 1 : 0
    if ((owner !== null && !isAlive(owner)) || ownerless > 50) {
      await rm(lockDir, { recursive: true, force: true })
      ownerless = 0
      continue
    }
    if (Date.now() > deadline) throw new Error(`TEST_LOCK_TIMEOUT: ${name} is still held by another test process.`)
    await sleep(POLL_MS)
  }
}

export async function withProcessLock<T>(name: string, action: () => Promise<T>, timeoutMs?: number): Promise<T> {
  const lock = await acquireProcessLock(name, timeoutMs)
  try {
    return await action()
  } finally {
    await lock.release()
  }
}

/** The lock every test that binds the committed demo port must hold. */
export const demoPortLockName = (port: number): string => `demo-port-${port}`
