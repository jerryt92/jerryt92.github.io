import {
  getMermaidThemeCss,
  getMermaidThemeVariables,
  getVegaLiteEmbedConfig,
  injectPlantUmlTheme
} from './diagramTheme'
import {
  buildMermaidRenderCandidates,
  isMermaidErrorSvg,
  parseVegaLiteSpec,
  type DiagramRenderType
} from './diagramSourceNormalize'
import {
  cancelDiagramRenderWorkerTasks,
  registerDiagramRenderFallback,
  renderDiagramInWorker as renderInWorker,
  resetDiagramRenderWorker,
  waitForDiagramRenderWorkerWarmup,
  warmupDiagramRenderWorker
} from './diagramRenderWorkerClient'

type MermaidModule = {
  default?: MermaidApi
} & MermaidApi

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void
  render: (
    id: string,
    text: string
  ) => Promise<{ svg: string; bindFunctions?: (element: Element) => void }>
}

type PlantUmlRenderer = (source: string) => Promise<string>

type VegaEmbedResult = {
  view?: { finalize: () => void }
}

type VegaEmbedFn = (
  element: HTMLElement,
  spec: Record<string, unknown>,
  options?: Record<string, unknown>
) => Promise<VegaEmbedResult>

let mermaidApi: MermaidApi | undefined
let mermaidSeq = 0
let plantUmlRenderer: PlantUmlRenderer | undefined
let plantUmlModuleLoad: Promise<PlantUmlRenderer> | undefined
let vegaEmbedFn: VegaEmbedFn | undefined
let runtimeInit: Promise<void> | undefined

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

const getVegaEmbed = async (): Promise<VegaEmbedFn> => {
  if (!vegaEmbedFn) {
    const mod = await import('vega-embed')
    const embed = mod.default
    if (typeof embed !== 'function') {
      throw new Error('vega-embed 模块未导出默认嵌入函数')
    }
    vegaEmbedFn = embed as VegaEmbedFn
  }
  return vegaEmbedFn
}

const renderMermaidMarkupFallback = async (source: string) => {
  const candidates = buildMermaidRenderCandidates(source)
  const mermaid = await getMermaidApi()
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      const id = `md-mermaid-${Date.now()}-${++mermaidSeq}`
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

const renderPlantUmlMarkupFallback = async (source: string) => {
  const renderer = await getPlantUmlRenderer()
  return renderer(injectPlantUmlTheme(source))
}

const renderVegaLiteMarkupFallback = async (source: string) => {
  const spec = parseVegaLiteSpec(source)
  const embed = await getVegaEmbed()
  const host = document.createElement('div')
  host.className = 'md-vegalite-host-fallback'
  host.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'
  document.body.appendChild(host)
  let view: { finalize: () => void } | undefined
  try {
    const result = await embed(host, spec, {
      actions: false,
      renderer: 'svg',
      theme: 'quartz',
      config: getVegaLiteEmbedConfig(),
      tooltip: { theme: 'light' }
    })
    view = result?.view
    const vegaSvg = host.querySelector('svg')
    if (!vegaSvg) {
      throw new Error('Vega-Lite 渲染未生成 SVG')
    }
    return vegaSvg.outerHTML
  } finally {
    view?.finalize()
    host.remove()
  }
}

const ensureDiagramRuntime = (): Promise<void> => {
  if (!runtimeInit) {
    runtimeInit = Promise.resolve().then(() => {
      registerDiagramRenderFallback(async (type, source) => {
        switch (type) {
          case 'mermaid':
            return renderMermaidMarkupFallback(source)
          case 'plantuml':
            return renderPlantUmlMarkupFallback(source)
          case 'vegalite':
            return renderVegaLiteMarkupFallback(source)
          default:
            throw new Error(`Unsupported diagram type: ${type satisfies never}`)
        }
      })
    })
  }
  return runtimeInit
}

const preloadMainThreadFallbackRuntimes = () =>
  Promise.all([
    getMermaidApi(),
    getPlantUmlRenderer().catch(() => {}),
    import('vega-lite').catch(() => {}),
    import('vega').catch(() => {}),
    import('vega-embed').catch(() => {})
  ]).then(() => {})

/** 登录/首页 idle 后后台预热 Worker 与图表 vendor（不阻塞 UI） */
export const preloadDiagramRuntimes = () => {
  void ensureDiagramRuntime()
  warmupDiagramRenderWorker()
}

/** 聊天页进入前阻塞，直至 Worker 图表运行时预热完成（或主线程 fallback 就绪） */
export const waitForDiagramRuntimesReady = async (): Promise<void> => {
  await ensureDiagramRuntime()
  if (typeof Worker === 'undefined') {
    await preloadMainThreadFallbackRuntimes()
    return
  }
  warmupDiagramRenderWorker()
  await waitForDiagramRenderWorkerWarmup()
}

export const renderDiagramInWorker = async (
  type: DiagramRenderType,
  source: string,
  signal?: AbortSignal
): Promise<string> => {
  await ensureDiagramRuntime()
  return renderInWorker(type, source, signal)
}

export const resetDiagramMarkdownRuntimeForTest = () => {
  mermaidApi = undefined
  mermaidSeq = 0
  plantUmlRenderer = undefined
  plantUmlModuleLoad = undefined
  vegaEmbedFn = undefined
  runtimeInit = undefined
  resetDiagramRenderWorker()
}

export { cancelDiagramRenderWorkerTasks, resetDiagramRenderWorker }
