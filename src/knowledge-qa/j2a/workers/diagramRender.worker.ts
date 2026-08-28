import {
  getMermaidThemeCss,
  getMermaidThemeVariables,
  getVegaLiteEmbedConfig,
  injectPlantUmlTheme
} from '../utils/diagramTheme'
import {
  buildMermaidRenderCandidates,
  isMermaidErrorSvg,
  parseVegaLiteSpec,
  type DiagramRenderType
} from '../utils/diagramSourceNormalize'

type MermaidModule = {
  default?: MermaidApi
} & MermaidApi

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void
  render: (
    id: string,
    text: string
  ) => Promise<{ svg: string }>
}

/** Vega View 最小化类型：仅用到 runAsync / toSVG / finalize */
type VegaView = {
  runAsync: () => Promise<unknown>
  toSVG: () => Promise<string>
  finalize: () => void
}

type PlantUmlRenderer = (source: string) => Promise<string>

type WorkerRenderRequest = {
  kind: 'render'
  id: string
  type: DiagramRenderType
  source: string
}

type WorkerWarmupRequest = {
  kind: 'warmup'
}

type WorkerRequest = WorkerRenderRequest | WorkerWarmupRequest

type WorkerResultResponse = {
  kind: 'result'
  id: string
  ok: boolean
  markup?: string
  error?: string
}

type WorkerWarmupResponse = {
  kind: 'warmup-done'
}

type WorkerResponse = WorkerResultResponse | WorkerWarmupResponse

let mermaidApi: MermaidApi | undefined
let mermaidSeq = 0
let plantUmlRenderer: PlantUmlRenderer | undefined
let plantUmlModuleLoad: Promise<PlantUmlRenderer> | undefined

const getMermaidApi = async () => {
  if (!mermaidApi) {
    const mod = (await import('mermaid')) as unknown as MermaidModule
    mermaidApi = mod.default || mod
    mermaidApi.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'default',
      themeVariables: getMermaidThemeVariables() as unknown as Record<
        string,
        unknown
      >,
      themeCSS: getMermaidThemeCss(),
      suppressErrorRendering: true
    })
  }
  return mermaidApi
}

const loadPlantUmlModule = () => {
  if (!plantUmlModuleLoad) {
    plantUmlModuleLoad = (async () => {
      await import('@plantuml/core/viz-global.js')
      const { renderToString } = await import('@plantuml/core')
      return (source: string) =>
        new Promise<string>((resolve, reject) => {
          const lines = source.split(/\r\n|\r|\n/)
          renderToString(lines, resolve, (message: string) =>
            reject(new Error(message))
          )
        })
    })()
  }
  return plantUmlModuleLoad
}

const getPlantUmlRenderer = async () => {
  if (!plantUmlRenderer) {
    plantUmlRenderer = await loadPlantUmlModule()
  }
  return plantUmlRenderer
}

const renderMermaidMarkup = async (source: string) => {
  const candidates = buildMermaidRenderCandidates(source)
  const mermaid = await getMermaidApi()
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      const id = `md-mermaid-worker-${Date.now()}-${++mermaidSeq}`
      const { svg } = await mermaid.render(id, candidate)
      if (isMermaidErrorSvg(svg)) {
        throw new Error('Mermaid 图表语法无效')
      }
      return svg
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError || 'Mermaid 图表语法无效'))
}

const renderPlantUmlMarkup = async (source: string) => {
  const renderer = await getPlantUmlRenderer()
  return renderer(injectPlantUmlTheme(source))
}

const renderVegaLiteMarkup = async (source: string) => {
  const spec = parseVegaLiteSpec(source)
  const config = getVegaLiteEmbedConfig()
  const { compile } = await import('vega-lite')
  const vega = await import('vega')
  const compiled = compile(spec as never, { config: config as never })
  const runtime = vega.parse(compiled.spec)
  // 必须 finalize：Vega View 内部 dataflow / scenegraph / timer 不释放会随每个图表泄漏，
  // 批量渲染时累积击穿 Worker 堆，进而拖垮整个渲染进程。
  const view = new vega.View(runtime, { renderer: 'svg' }) as unknown as VegaView
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

const renderDiagram = async (type: DiagramRenderType, source: string) => {
  switch (type) {
    case 'mermaid':
      return renderMermaidMarkup(source)
    case 'plantuml':
      return renderPlantUmlMarkup(source)
    case 'vegalite':
      return renderVegaLiteMarkup(source)
    default:
      throw new Error(`Unsupported diagram type: ${type satisfies never}`)
  }
}

const warmupRuntimes = async () => {
  await Promise.all([
    getMermaidApi(),
    getPlantUmlRenderer().catch(() => {}),
    import('vega-lite').catch(() => {}),
    import('vega').catch(() => {})
  ])
}

const postResult = (response: WorkerResultResponse) => {
  self.postMessage(response satisfies WorkerResponse)
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const message = event.data
  if (!message || typeof message !== 'object') {
    return
  }

  if (message.kind === 'warmup') {
    void warmupRuntimes()
      .then(() => {
        self.postMessage({ kind: 'warmup-done' } satisfies WorkerWarmupResponse)
      })
      .catch(() => {
        self.postMessage({ kind: 'warmup-done' } satisfies WorkerWarmupResponse)
      })
    return
  }

  if (message.kind !== 'render') {
    return
  }

  void renderDiagram(message.type, message.source)
    .then((markup) => {
      postResult({
        kind: 'result',
        id: message.id,
        ok: true,
        markup
      })
    })
    .catch((error: unknown) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error || 'Unknown error')
      postResult({
        kind: 'result',
        id: message.id,
        ok: false,
        error: errorMessage
      })
    })
})
