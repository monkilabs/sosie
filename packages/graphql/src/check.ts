import { Worker } from 'node:worker_threads'
import { introspectionFromSchema, type GraphQLSchema } from 'graphql'
import type { CheckAnswer, CheckJob } from './check-worker.js'

/** How long a query may take to check, or its introspection to answer, and the memory for it: more, and it is refused. */
const CHECK_SECONDS = 2
const CHECK_MB = 256
/** Threads: while one works on a costly query, the other answers everyone else. */
const THREADS = 2
/** The largest introspection answer: as large as an answer Sosie reads from the API. */
export const MAX_ANSWER = 20 * 1024 * 1024

const TOO_COSTLY = `The query asks for more than Sosie checks or answers at once (${CHECK_SECONDS} s, ${CHECK_MB} MB). Ask for less.`

type Pending = { job: CheckJob; done: (answer: CheckAnswer) => void }
type Slot = { worker: Worker; busy?: Pending; timer?: NodeJS.Timeout }
type Job = { [K in CheckJob['kind']]: Omit<Extract<CheckJob, { kind: K }>, 'id'> }[CheckJob['kind']]

/**
 * Queries checked, and introspection answered, on threads of their own, each
 * job within a time and a memory limit, so a query that asks for too much is
 * refused instead of keeping other clients waiting or stopping Sosie.
 */
export class Checker {
  readonly #data: { introspection: ReturnType<typeof introspectionFromSchema>; maxTokens: number; maxAnswer: number }
  readonly #slots: Slot[] = []
  readonly #queue: Pending[] = []
  #next = 0
  #closed = false

  constructor(schema: GraphQLSchema, maxTokens: number) {
    this.#data = { introspection: introspectionFromSchema(schema), maxTokens, maxAnswer: MAX_ANSWER }
    for (let i = 0; i < THREADS; i++) this.#slots.push({ worker: this.#start() })
  }

  /** The query's errors against the schema; none when it is valid. */
  validate(query: string): Promise<CheckAnswer> {
    return this.#run({ kind: 'validate', query })
  }

  /** The answer to a query of introspection only, as JSON text. */
  introspect(query: string, operationName: string | undefined, variables: Record<string, unknown>): Promise<CheckAnswer> {
    return this.#run({ kind: 'introspect', query, operationName, variables })
  }

  async close(): Promise<void> {
    this.#closed = true
    // Every job is answered, those a thread is working on too, so no request waits on a thread that is gone.
    for (const slot of this.#slots) {
      clearTimeout(slot.timer)
      if (slot.busy) this.#queue.push(slot.busy)
      slot.busy = undefined
    }
    for (const pending of this.#queue.splice(0)) pending.done({ id: pending.job.id, refused: 'Sosie is stopping.' })
    await Promise.all(this.#slots.map((slot) => slot.worker.terminate()))
  }

  #run(job: Job): Promise<CheckAnswer> {
    return new Promise((done) => {
      if (this.#closed) return done({ id: 0, refused: 'Sosie is stopping.' })
      this.#queue.push({ job: { ...job, id: ++this.#next } as CheckJob, done })
      this.#dispatch()
    })
  }

  #start(): Worker {
    const file = import.meta.url.endsWith('.ts') ? './check-worker.ts' : './check-worker.js'
    const worker = new Worker(new URL(file, import.meta.url), { workerData: this.#data, resourceLimits: { maxOldGenerationSizeMb: CHECK_MB } })
    // A running Sosie is kept alive by its server, never by these threads.
    worker.unref()
    worker.on('message', (answer: CheckAnswer) => {
      const slot = this.#slots.find((s) => s.worker === worker)
      if (!slot?.busy || slot.busy.job.id !== answer.id) return
      clearTimeout(slot.timer)
      const { done } = slot.busy
      slot.busy = undefined
      done(answer)
      this.#dispatch()
    })
    // Out of memory, or failed: the job is refused, and a new thread takes the slot.
    worker.on('error', () => this.#replace(worker))
    worker.on('exit', () => this.#replace(worker))
    return worker
  }

  #dispatch(): void {
    for (const slot of this.#slots) {
      if (slot.busy || !this.#queue.length) continue
      const pending = this.#queue.shift()!
      slot.busy = pending
      slot.timer = setTimeout(() => this.#replace(slot.worker), CHECK_SECONDS * 1000).unref()
      slot.worker.postMessage(pending.job)
    }
  }

  /** Stop a thread that took too long, ran out of memory or failed; refuse its job; start another in its place. */
  #replace(worker: Worker): void {
    const slot = this.#slots.find((s) => s.worker === worker)
    if (!slot || this.#closed) return
    clearTimeout(slot.timer)
    const pending = slot.busy
    slot.busy = undefined
    slot.worker = this.#start()
    void worker.terminate()
    pending?.done({ id: pending.job.id, refused: TOO_COSTLY })
    this.#dispatch()
  }
}
