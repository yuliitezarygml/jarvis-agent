export class RoutineCancelledError extends Error {
  constructor() {
    super('routine cancelled')
    this.name = 'RoutineCancelledError'
  }
}

/** One execution owns its signal, including delays and child processes. */
export class RoutineCancellation {
  private controller = new AbortController()
  readonly signal = this.controller.signal

  cancel() {
    this.controller.abort(new RoutineCancelledError())
  }

  check() {
    if (this.signal.aborted) throw new RoutineCancelledError()
  }

  async perform<T>(action: () => Promise<T>): Promise<T> {
    this.check()
    const result = await action()
    this.check()
    return result
  }

  wait(ms: number): Promise<void> {
    this.check()
    return new Promise((resolve, reject) => {
      const finish = () => {
        this.signal.removeEventListener('abort', abort)
        resolve()
      }
      const abort = () => {
        clearTimeout(timer)
        this.signal.removeEventListener('abort', abort)
        reject(new RoutineCancelledError())
      }
      const timer = setTimeout(finish, Number.isFinite(ms) ? Math.max(0, ms) : 0)
      this.signal.addEventListener('abort', abort, { once: true })
    })
  }
}

/** A new routine replaces the previous one, after its held keys/processes have been cleaned up. */
export class RoutineRunner {
  private current: RoutineCancellation | null = null
  private tail: Promise<void> = Promise.resolve()

  get active() {
    return this.current !== null
  }

  cancel() {
    this.current?.cancel()
  }

  settled() {
    return this.tail
  }

  run<T extends { type: string; after?: number }>(
    steps: readonly T[],
    execute: (step: T, run: RoutineCancellation) => Promise<string>,
    failed?: (step: T) => void
  ): Promise<string> {
    this.cancel()
    const run = new RoutineCancellation()
    this.current = run
    const previous = this.tail
    const result = (async () => {
      const log: string[] = []
      try {
        await previous
        run.check()
        for (const step of steps) {
          try {
            const message = await run.perform(() => execute(step, run))
            if (step.after) await run.wait(Math.min(step.after, 60000))
            log.push(message)
          } catch (error) {
            if (run.signal.aborted || error instanceof RoutineCancelledError) throw error
            log.push(`step ${step.type} failed: ${error instanceof Error ? error.message : String(error)}`)
            failed?.(step)
          }
        }
      } catch (error) {
        if (!run.signal.aborted && !(error instanceof RoutineCancelledError)) throw error
        log.push('■ Routine cancelled')
      } finally {
        if (this.current === run) this.current = null
      }
      return log.join('\n')
    })()
    this.tail = result.then(() => {}, () => {})
    return result
  }
}
