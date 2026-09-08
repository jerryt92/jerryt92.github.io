import type { DiagramRenderType } from './diagramSourceNormalize'

export type DiagramRenderFallback = (
  type: DiagramRenderType,
  source: string
) => Promise<string>

type PendingTask = {
  id: string
  type: DiagramRenderType
  source: string
  signal?: AbortSignal
  onAbort: () => void
  resolve: (markup: string) => void
  reject: (error: Error) => void
}

const WORKER_RECYCLE_AFTER = 18
const DEFAULT_CONCURRENCY = 2
const WORKER_REQUEST_TIMEOUT_MS = 120_000
const WORKER_WARMUP_TIMEOUT_MS = 120_000

let worker: Worker | undefined
let workerDisabled = false
let completedRenderCount = 0
let inFlightCount = 0
let taskSeq = 0
let fallbackRenderer: DiagramRenderFallback | undefined
let warmupSent = false
let warmupCompleted = false
let warmupWaiters: Array<() => void> = []
let warmupTimeoutId: ReturnType<typeof setTimeout> | undefined
let recyclePending = false

const resetWarmupWaitState = () => {
  warmupCompleted = false
  warmupWaiters = []
  if (warmupTimeoutId) {
    clearTimeout(warmupTimeoutId)
    warmupTimeoutId = undefined
  }
}

const notifyWarmupDone = () => {
  if (warmupCompleted) {
    return
  }
  warmupCompleted = true
  if (warmupTimeoutId) {
    clearTimeout(warmupTimeoutId)
    warmupTimeoutId = undefined
  }
  for (const resolve of warmupWaiters) {
    resolve()
  }
  warmupWaiters = []
}

const queue: PendingTask[] = []
const pendingById = new Map<string, PendingTask>()
const timeoutById = new Map<string, ReturnType<typeof setTimeout>>()

export class DiagramRenderWorkerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiagramRenderWorkerError'
  }
}

const rejectTask = (task: PendingTask, error: Error) => {
  pendingById.delete(task.id)
  const timer = timeoutById.get(task.id)
  if (timer) {
    clearTimeout(timer)
    timeoutById.delete(task.id)
  }
  if (task.signal) {
    task.signal.removeEventListener('abort', task.onAbort)
  }
  task.reject(error)
}

const resolveTask = (task: PendingTask, markup: string) => {
  pendingById.delete(task.id)
  const timer = timeoutById.get(task.id)
  if (timer) {
    clearTimeout(timer)
    timeoutById.delete(task.id)
  }
  if (task.signal) {
    task.signal.removeEventListener('abort', task.onAbort)
  }
  task.resolve(markup)
}

const scheduleTaskTimeout = (task: PendingTask) => {
  const timer = setTimeout(() => {
    if (!pendingById.has(task.id)) {
      return
    }
    rejectTask(task, new DiagramRenderWorkerError('Diagram worker render timeout'))
    requestWorkerRecycle()
    drainQueue()
  }, WORKER_REQUEST_TIMEOUT_MS)
  timeoutById.set(task.id, timer)
}

const attachAbortHandler = (task: PendingTask) => {
  if (!task.signal) {
    return
  }
  task.onAbort = () => {
    rejectTask(task, new DiagramRenderWorkerError('Diagram render aborted'))
    inFlightCount = Math.max(0, inFlightCount - 1)
    drainQueue()
  }
  if (task.signal.aborted) {
    task.onAbort()
    return
  }
  task.signal.addEventListener('abort', task.onAbort, { once: true })
}

const createWorker = (): Worker | undefined => {
  if (typeof Worker === 'undefined' || workerDisabled) {
    return undefined
  }
  try {
    return new Worker(
      new URL('../workers/diagramRender.worker.ts', import.meta.url),
      { type: 'module' }
    )
  } catch {
    workerDisabled = true
    return undefined
  }
}

const ensureWorker = (): Worker | undefined => {
  if (workerDisabled) {
    return undefined
  }
  if (!worker) {
    worker = createWorker()
    if (!worker) {
      return undefined
    }
    worker.addEventListener('message', handleWorkerMessage)
    worker.addEventListener('error', handleWorkerError)
  }
  return worker
}

/**
 * 可安全回收的时机：在途与 pending 均清空即可，**不再要求队列也为空**。
 * 旧逻辑要求 `queue.length === 0`，导致一次性排入大量图表时 Worker 在整批渲染完前
 * 永不回收，泄漏（如 Vega View）与运行时碎片持续累积，最终击穿渲染进程内存。
 * 现在达阈值后会在「两批之间」回收：暂停派发 → 在途排空 → terminate → 重建继续队列。
 */
const canRecycleWorkerNow = () =>
  inFlightCount === 0 && pendingById.size === 0

const requestWorkerRecycle = () => {
  if (!canRecycleWorkerNow()) {
    recyclePending = true
    return
  }
  recyclePending = false
  recycleWorker()
}

const tryCompletePendingRecycle = () => {
  if (!recyclePending || completedRenderCount < WORKER_RECYCLE_AFTER) {
    return
  }
  requestWorkerRecycle()
}

const handleWorkerError = () => {
  const failedTasks = [...pendingById.values()]
  recycleWorker(true)
  recyclePending = false
  for (const task of failedTasks) {
    inFlightCount = Math.max(0, inFlightCount - 1)
    void finishTaskWithFallback(task, 'Diagram worker crashed')
  }
  drainQueue()
}

const handleWorkerMessage = (event: MessageEvent) => {
  const data = event.data
  if (!data || typeof data !== 'object') {
    return
  }

  if (data.kind === 'warmup-done') {
    notifyWarmupDone()
    return
  }

  if (data.kind !== 'result' || typeof data.id !== 'string') {
    return
  }

  const task = pendingById.get(data.id)
  if (!task) {
    return
  }

  inFlightCount = Math.max(0, inFlightCount - 1)
  completedRenderCount += 1

  if (data.ok && typeof data.markup === 'string') {
    resolveTask(task, data.markup)
  } else {
    void finishTaskWithFallback(
      task,
      typeof data.error === 'string' ? data.error : 'Diagram worker render failed'
    ).finally(() => {
      drainQueue()
    })
  }

  if (completedRenderCount >= WORKER_RECYCLE_AFTER) {
    requestWorkerRecycle()
  }

  drainQueue()
}

const recycleWorker = (fromError = false) => {
  if (worker) {
    worker.removeEventListener('message', handleWorkerMessage)
    worker.removeEventListener('error', handleWorkerError)
    worker.terminate()
    worker = undefined
  }
  completedRenderCount = 0
  warmupSent = false
  resetWarmupWaitState()
  if (fromError) {
    workerDisabled = false
  }
}

const finishTaskWithFallback = async (
  task: PendingTask,
  workerError?: string
) => {
  pendingById.delete(task.id)
  const timer = timeoutById.get(task.id)
  if (timer) {
    clearTimeout(timer)
    timeoutById.delete(task.id)
  }
  if (task.signal) {
    task.signal.removeEventListener('abort', task.onAbort)
  }

  if (task.signal?.aborted) {
    task.reject(new DiagramRenderWorkerError('Diagram render aborted'))
    return
  }

  if (!fallbackRenderer) {
    task.reject(
      new DiagramRenderWorkerError(
        workerError || 'Diagram worker unavailable and no fallback registered'
      )
    )
    return
  }

  try {
    const markup = await fallbackRenderer(task.type, task.source)
    if (task.signal?.aborted) {
      task.reject(new DiagramRenderWorkerError('Diagram render aborted'))
      return
    }
    task.resolve(markup)
  } catch (error) {
    task.reject(
      error instanceof Error
        ? error
        : new DiagramRenderWorkerError(
            workerError || String(error || 'Fallback render failed')
          )
    )
  }
}

const dispatchToWorker = (task: PendingTask) => {
  const activeWorker = ensureWorker()
  if (!activeWorker) {
    inFlightCount += 1
    void finishTaskWithFallback(task, 'Diagram worker unavailable').finally(() => {
      inFlightCount = Math.max(0, inFlightCount - 1)
      drainQueue()
    })
    return
  }

  inFlightCount += 1
  pendingById.set(task.id, task)
  attachAbortHandler(task)
  if (task.signal?.aborted) {
    inFlightCount = Math.max(0, inFlightCount - 1)
    pendingById.delete(task.id)
    drainQueue()
    return
  }
  scheduleTaskTimeout(task)
  activeWorker.postMessage({
    kind: 'render',
    id: task.id,
    type: task.type,
    source: task.source
  })
}

const drainQueue = () => {
  // 已达回收阈值：暂停派发新任务，等在途任务排空后回收 Worker，避免整批渲染期间堆积。
  if (recyclePending) {
    if (canRecycleWorkerNow()) {
      recyclePending = false
      recycleWorker()
    } else {
      return
    }
  }
  while (inFlightCount < DEFAULT_CONCURRENCY && queue.length > 0) {
    const task = queue.shift()
    if (!task) {
      return
    }
    if (task.signal?.aborted) {
      task.reject(new DiagramRenderWorkerError('Diagram render aborted'))
      continue
    }
    dispatchToWorker(task)
  }
  tryCompletePendingRecycle()
}

export const registerDiagramRenderFallback = (
  renderer: DiagramRenderFallback
) => {
  fallbackRenderer = renderer
}

export const warmupDiagramRenderWorker = () => {
  const activeWorker = ensureWorker()
  if (!activeWorker || warmupSent) {
    return
  }
  warmupSent = true
  activeWorker.postMessage({ kind: 'warmup' })
}

/** 等待 Worker 内 mermaid/plantuml/vega 预热完成；已预热或 Worker 不可用时立即 resolve */
export const waitForDiagramRenderWorkerWarmup = (): Promise<void> => {
  if (warmupCompleted) {
    return Promise.resolve()
  }
  if (typeof Worker === 'undefined' || workerDisabled) {
    return Promise.resolve()
  }
  warmupDiagramRenderWorker()
  return new Promise((resolve) => {
    warmupWaiters.push(resolve)
    if (!warmupTimeoutId) {
      warmupTimeoutId = setTimeout(() => {
        notifyWarmupDone()
      }, WORKER_WARMUP_TIMEOUT_MS)
    }
  })
}

export const getActiveDiagramRenderCount = () => inFlightCount + queue.length

/**
 * 取消排队与 Worker 在途任务，但不 terminate Worker（避免反复冷启动）。
 * 会话切换 / cancelPendingMarkdownRenderWork 时调用，防止算力空转与主线程 fallback 风暴。
 */
export const cancelDiagramRenderWorkerTasks = () => {
  while (queue.length > 0) {
    const task = queue.shift()
    if (task) {
      if (task.signal) {
        task.signal.removeEventListener('abort', task.onAbort)
      }
      task.reject(new DiagramRenderWorkerError('Diagram render aborted'))
    }
  }
  for (const task of [...pendingById.values()]) {
    rejectTask(task, new DiagramRenderWorkerError('Diagram render aborted'))
    inFlightCount = Math.max(0, inFlightCount - 1)
  }
  recyclePending = false
}

export const resetDiagramRenderWorker = () => {
  while (queue.length > 0) {
    const task = queue.shift()
    if (task) {
      task.reject(new DiagramRenderWorkerError('Diagram worker reset'))
    }
  }
  for (const task of [...pendingById.values()]) {
    rejectTask(task, new DiagramRenderWorkerError('Diagram worker reset'))
  }
  recyclePending = false
  recycleWorker()
  workerDisabled = false
}

export const renderDiagramInWorker = (
  type: DiagramRenderType,
  source: string,
  signal?: AbortSignal
): Promise<string> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DiagramRenderWorkerError('Diagram render aborted'))
      return
    }

    const task: PendingTask = {
      id: `diagram-task-${Date.now()}-${++taskSeq}`,
      type,
      source,
      signal,
      onAbort: () => {},
      resolve,
      reject
    }

    queue.push(task)
    drainQueue()
  })
