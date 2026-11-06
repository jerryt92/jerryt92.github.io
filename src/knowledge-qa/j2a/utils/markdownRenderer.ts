import MarkdownIt from 'markdown-it'
import { t } from '../shims/lib'
import { appendAuthTokenToUrl } from './authenticatedUrl'
import { normalizeMarkdownRepoFileUrls, normalizeRepoFileUrl } from './repoFileUrl'
import { DIAGRAM_COLOR_PALETTE, DIAGRAM_FONT_FAMILY } from './diagramTheme'
import {
  countXychartBarValues,
  countXychartCategories,
  getXychartCategoryCount,
  getXychartDeclarationLine,
  isXychartHorizontal,
  isXychartSource,
  normalizeMermaidSource,
  normalizeXychartOrientation,
  tryParseVegaLiteSpec,
  XYCHART_HORIZONTAL_MIN_CATEGORIES
} from './diagramSourceNormalize'
import { DiagramRenderWorkerError } from './diagramRenderWorkerClient'

const MARKDOWN_RENDER_ATTR = 'data-md-render'
const MARKDOWN_RENDERED_ATTR = 'data-md-rendered'
const MARKDOWN_RENDERING_ATTR = 'data-md-rendering'
const MARKDOWN_REVISION_ATTR = 'data-md-revision'
const MARKDOWN_FENCE_OPEN_ATTR = 'data-md-fence-open'
const MARKDOWN_OFFSCREEN_ATTR = 'data-md-offscreen'
/**
 * 图表后处理逻辑变更时递增，用于让历史气泡在 SPA 内重新渲染（非 Mermaid 缓存）。
 * 与 ChatView 中 v-html 的 :key 保持一致。
 */
export const MARKDOWN_RENDERER_REVISION = '32'
/** 与 markdown.scss 中 --md-diagram-max-height 回退值保持一致 */
const MARKDOWN_DIAGRAM_MAX_HEIGHT_FALLBACK = 360
/** 与 markdown.scss 中 --md-html-preview-max-height 回退值保持一致 */
const MARKDOWN_HTML_PREVIEW_MAX_HEIGHT_FALLBACK = 300
/** 缩略图测量高度余量，避免 margin/box-shadow/缩放取整裁切底部 */
const HTML_PREVIEW_THUMB_MEASURE_PADDING = 20
/** body 垂直内边距合计（padding-top + padding-bottom，各 14px） */
const MARKDOWN_DIAGRAM_BODY_PADDING_VERTICAL = 28
/** body 水平内边距合计（padding-left + padding-right，各 16px） */
const MARKDOWN_DIAGRAM_BODY_PADDING_HORIZONTAL = 32
/** 横向条形图每行类目预留高度（px），用于拉高容器减少行挤压 */
const XYCHART_HORIZONTAL_ROW_MIN_HEIGHT = 22
/** 竖向图底部标签换行时的行高系数 */
const XYCHART_LABEL_LINE_HEIGHT_RATIO = 1.25
/** 换行后 viewBox / 容器底部预留（px） */
const XYCHART_WRAPPED_LABEL_BOTTOM_PAD = 20
const MARKDOWN_HTML_CACHE_MAX_ENTRIES = 200
/** 全局已渲染图表 markup LRU 上限 */
const DIAGRAM_MARKUP_CACHE_MAX_ENTRIES = 200
/** 单会话已渲染图表 markup 上限 */
const DIAGRAM_MARKUP_CACHE_MAX_PER_SESSION = 50
const HTML_PREVIEW_MAX_MEASURE_NODES = 200
const MARKDOWN_FIT_WIDTH_ATTR = 'data-md-fit-width'
/** 流式尾段 markdown-it 最小更新间隔（ms），与 rAF 合并使用 */
const STREAM_TAIL_MIN_INTERVAL_MS = 80
/** 窗口 resize 全局 refit 防抖（ms） */
const DIAGRAM_WINDOW_RESIZE_DEBOUNCE_MS = 180
/** 单帧 refit 预算，避免多图同帧阻塞主线程 */
const REFIT_BUDGET_PER_FRAME = 8
/** HTML 预览 iframe 高度测量防抖（ms） */
const HTML_PREVIEW_FIT_DEBOUNCE_MS = 150
/** abort/detached 后重扫 pending 块防抖（ms） */
const DIAGRAM_BLOCK_RETRY_DEBOUNCE_MS = 50

const markdownHtmlCache = new Map<string, string>()
/** 会话级已渲染图表 markup：切回历史会话时跳过 Worker */
const diagramMarkupCache = new Map<string, string>()
const diagramMarkupCacheSessionCounts = new Map<string, number>()
const pendingRefitBodies = new Set<HTMLElement>()
const diagramFitInProgress = new WeakSet<HTMLElement>()
let batchRefitRafId = 0
let renderMarkdownBlocksChain: Promise<void> = Promise.resolve()
let markdownRenderGeneration = 0

const diagramFitObservers = new WeakMap<HTMLElement, ResizeObserver>()
const diagramFitRafIds = new WeakMap<HTMLElement, number>()
const diagramFitThrottleTimers = new WeakMap<
  HTMLElement,
  ReturnType<typeof setTimeout>
>()
const DIAGRAM_REFIT_THROTTLE_MS = 100
let diagramWindowResizeBound = false
let diagramWindowResizeDebounceTimer = 0
let globalResizeInProgress = false
let diagramBlockRetryTimer = 0
let diagramBlockRetryRoot: Element | null = null
const deferredHtmlPreviewIframes = new Set<HTMLIFrameElement>()
const htmlPreviewFitTimers = new WeakMap<
  HTMLIFrameElement,
  ReturnType<typeof setTimeout>
>()
let diagramMaxHeightCache = 0
let htmlPreviewMaxHeightCache = 0

/** 读取 CSS 变量高度的解析结果（px） */
const readMarkdownCssHeight = (cssVar: string, fallback: number) => {
  if (typeof document === 'undefined') {
    return fallback
  }
  const root =
    (document.querySelector('.message-md') as HTMLElement | null) ||
    document.documentElement
  const probe = document.createElement('div')
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;height:${cssVar}`
  root.appendChild(probe)
  const height = Math.round(probe.getBoundingClientRect().height)
  root.removeChild(probe)
  return height > 0 ? height : fallback
}

/** 读取 CSS 变量 --md-diagram-max-height 的解析结果（px） */
const getMarkdownDiagramMaxHeight = () => {
  if (diagramMaxHeightCache > 0) {
    return diagramMaxHeightCache
  }
  diagramMaxHeightCache = readMarkdownCssHeight(
    'var(--md-diagram-max-height)',
    MARKDOWN_DIAGRAM_MAX_HEIGHT_FALLBACK
  )
  return diagramMaxHeightCache
}

/** 读取 CSS 变量 --md-html-preview-max-height 的解析结果（px） */
const getMarkdownHtmlPreviewMaxHeight = () => {
  if (htmlPreviewMaxHeightCache > 0) {
    return htmlPreviewMaxHeightCache
  }
  htmlPreviewMaxHeightCache = readMarkdownCssHeight(
    'var(--md-html-preview-max-height)',
    MARKDOWN_HTML_PREVIEW_MAX_HEIGHT_FALLBACK
  )
  return htmlPreviewMaxHeightCache
}

/** 图表内容区最大高度（扣除 body 垂直内边距） */
const getDiagramContentMaxHeight = () =>
  getMarkdownDiagramMaxHeight() - MARKDOWN_DIAGRAM_BODY_PADDING_VERTICAL

/** 窗口尺寸变化后需重新解析 vh 上限 */
const invalidateDiagramMaxHeightCache = () => {
  diagramMaxHeightCache = 0
  htmlPreviewMaxHeightCache = 0
}

/** 断开图表容器的尺寸监听 */
const disconnectDiagramFitObserver = (body: HTMLElement) => {
  const observer = diagramFitObservers.get(body)
  if (observer) {
    observer.disconnect()
    diagramFitObservers.delete(body)
  }
  const rafId = diagramFitRafIds.get(body)
  if (rafId) {
    cancelAnimationFrame(rafId)
    diagramFitRafIds.delete(body)
  }
}

/**
 * 确保 SVG 外包一层 `.md-diagram-fit` 用于同步占位高度。
 *
 * 注意：SVG 不一定是 body 的直接子节点（如 Vega-Lite 的结构是
 * `body > .md-vegalite-host > .vega-embed > svg`）。此时旧实现用
 * `body.insertBefore(wrap, svg)` 会抛 NotFoundError（参照节点非 body 子节点），
 * 导致整个 fit 中断、容器不被撑开/缩放、图被 max-height 裁掉。
 * 改为「wrap 追加到 body，再把 svg 移入 wrap」，无论 svg 原先嵌套多深都安全。
 */
const ensureDiagramFitWrapper = (body: HTMLElement, svg: SVGElement) => {
  let wrap = body.querySelector(
    ':scope > .md-diagram-fit'
  ) as HTMLElement | null
  if (!wrap) {
    wrap = document.createElement('div')
    wrap.className = 'md-diagram-fit'
    body.appendChild(wrap)
  }
  if (svg.parentNode !== wrap) {
    wrap.appendChild(svg)
  }
  return wrap
}

/**
 * 读取 SVG 自然尺寸（优先 viewBox，其次 width/height 属性，再 getBBox）。
 */
const getSvgNaturalSize = (svg: SVGElement) => {
  const viewBox = svg.getAttribute('viewBox')
  if (viewBox) {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/)
      .map((value) => Number(value))
    if (parts.length === 4 && parts.every((value) => !Number.isNaN(value))) {
      return { width: parts[2], height: parts[3] }
    }
  }

  const widthAttr = Number.parseFloat(svg.getAttribute('width') || '')
  const heightAttr = Number.parseFloat(svg.getAttribute('height') || '')
  if (widthAttr > 0 && heightAttr > 0) {
    return { width: widthAttr, height: heightAttr }
  }

  try {
    const box = (svg as SVGGraphicsElement).getBBox()
    if (box.width > 0 && box.height > 0) {
      return { width: box.width, height: box.height }
    }
  } catch {
    /* SVG 尚未参与布局时 getBBox 可能失败 */
  }

  const rect = svg.getBoundingClientRect()
  return {
    width: Math.max(rect.width, 1),
    height: Math.max(rect.height, 1)
  }
}

/**
 * 按 SVG 自然尺寸等比缩放至气泡内容区宽高上限内，容器高度贴合缩放后尺寸。
 * 宽度始终不超过气泡，不出现横向滚动条。
 */
const fitDiagramSvgInBody = (body: HTMLElement) => {
  const svg = body.querySelector('svg')
  if (!svg || !(svg instanceof SVGElement)) {
    return
  }

  diagramFitInProgress.add(body)
  try {
    fitDiagramSvgInBodyInner(body, svg)
  } finally {
    diagramFitInProgress.delete(body)
  }
}

const fitDiagramSvgInBodyInner = (body: HTMLElement, svg: SVGElement) => {
  const block = body.closest('.md-diagram') as HTMLElement | null
  const maxBodyHeight = getMarkdownDiagramMaxHeight()
  const contentMaxHeight = getDiagramContentMaxHeight()
  const wrap = ensureDiagramFitWrapper(body, svg)

  const bodyWidth = Math.max(
    body.clientWidth - MARKDOWN_DIAGRAM_BODY_PADDING_HORIZONTAL,
    120
  )
  const prevFitWidth = body.getAttribute(MARKDOWN_FIT_WIDTH_ATTR)
  if (
    prevFitWidth === String(bodyWidth) &&
    body.style.height &&
    svg.getAttribute('width')
  ) {
    return
  }
  body.setAttribute(MARKDOWN_FIT_WIDTH_ATTR, String(bodyWidth))

  const natural = getSvgNaturalSize(svg)
  const scaleWidth = bodyWidth / natural.width
  const scale = Math.min(1, scaleWidth, contentMaxHeight / natural.height)

  const displayWidth = Math.max(1, Math.ceil(natural.width * scale))
  const displayHeight = Math.max(1, Math.ceil(natural.height * scale))

  svg.style.transform = ''
  svg.style.transformOrigin = ''
  svg.style.display = 'block'
  svg.style.margin = '0 auto'
  svg.style.boxSizing = 'border-box'
  svg.style.maxWidth = 'none'
  svg.style.maxHeight = 'none'
  svg.style.width = `${displayWidth}px`
  svg.style.height = `${displayHeight}px`

  wrap.style.width = `${displayWidth}px`
  wrap.style.maxWidth = '100%'
  wrap.style.maxHeight = `${displayHeight}px`
  wrap.style.overflow = 'hidden'
  wrap.style.margin = '0 auto'
  wrap.style.lineHeight = '0'
  wrap.style.height = `${displayHeight}px`

  const bodyHeight = maxBodyHeight
  body.style.boxSizing = 'border-box'
  body.style.minHeight = `${bodyHeight}px`
  body.style.maxHeight = `${bodyHeight}px`
  body.style.height = `${bodyHeight}px`
  body.style.display = 'flex'
  body.style.alignItems = 'center'
  body.style.justifyContent = 'center'
  body.classList.remove('md-diagram-body--wide')
  body.style.overflowX = 'hidden'
  body.style.overflow = 'hidden'

  if (block) {
    block.style.minHeight = `${bodyHeight}px`
    block.style.maxHeight = `${bodyHeight}px`
    block.style.height = `${bodyHeight}px`
    block.style.overflow = 'hidden'
  }
}

/** keep-alive 隐藏或 display:none 的图表不参与 window resize refit */
const isDiagramBodyReflowEligible = (body: HTMLElement): boolean => {
  if (!body.isConnected) {
    return false
  }
  if (typeof body.checkVisibility === 'function') {
    return body.checkVisibility({
      checkOpacity: true,
      checkVisibilityCSS: true
    })
  }
  const rect = body.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/** 合并滚动/resize 期间的重复 refit，避免主线程被 ResizeObserver 打满 */
const scheduleFitDiagramSvgReflowThrottled = (body: HTMLElement) => {
  if (!isDiagramBodyReflowEligible(body)) {
    return
  }
  if (diagramFitInProgress.has(body)) {
    return
  }
  if (diagramFitThrottleTimers.has(body)) {
    return
  }
  const timer = setTimeout(() => {
    diagramFitThrottleTimers.delete(body)
    scheduleFitDiagramSvgReflow(body)
  }, DIAGRAM_REFIT_THROTTLE_MS)
  diagramFitThrottleTimers.set(body, timer)
}

const flushBatchDiagramRefit = () => {
  batchRefitRafId = 0
  const bodies = [...pendingRefitBodies]
  pendingRefitBodies.clear()
  const chunk = bodies.slice(0, REFIT_BUDGET_PER_FRAME)
  chunk.forEach((body) => {
    fitDiagramSvgInBody(body)
  })
  for (const body of bodies.slice(REFIT_BUDGET_PER_FRAME)) {
    pendingRefitBodies.add(body)
  }
  if (pendingRefitBodies.size > 0) {
    batchRefitRafId = requestAnimationFrame(flushBatchDiagramRefit)
  }
}

const isBodyInReflowViewport = (body: HTMLElement, marginPx: number) => {
  const rect = body.getBoundingClientRect()
  const vh = window.innerHeight
  const vw = window.innerWidth
  return (
    rect.bottom >= -marginPx &&
    rect.top <= vh + marginPx &&
    rect.right >= 0 &&
    rect.left <= vw
  )
}

const flushDeferredHtmlPreviewFits = () => {
  if (deferredHtmlPreviewIframes.size === 0) {
    return
  }
  const iframes = [...deferredHtmlPreviewIframes]
  deferredHtmlPreviewIframes.clear()
  iframes.forEach((iframe) => scheduleHtmlPreviewFit(iframe))
}

const scheduleGlobalDiagramReflow = () => {
  globalResizeInProgress = true
  invalidateDiagramMaxHeightCache()
  const marginPx = Math.max(2400, window.innerHeight * 2.5)
  const visible: HTMLElement[] = []
  const offscreen: HTMLElement[] = []
  document.querySelectorAll<HTMLElement>('.md-diagram-body').forEach((body) => {
    if (!isDiagramBodyReflowEligible(body)) {
      return
    }
    if (isBodyInReflowViewport(body, marginPx)) {
      visible.push(body)
    } else {
      offscreen.push(body)
    }
  })
  visible.forEach((body) => scheduleFitDiagramSvgReflow(body))
  if (offscreen.length > 0) {
    scheduleIdle(() => {
      offscreen.forEach((body) => scheduleFitDiagramSvgReflow(body))
      globalResizeInProgress = false
      flushDeferredHtmlPreviewFits()
    })
  } else {
    globalResizeInProgress = false
    flushDeferredHtmlPreviewFits()
  }
}

/** 批量 refit，合并同一帧内的多次 ResizeObserver 触发 */
const scheduleFitDiagramSvgReflow = (body: HTMLElement) => {
  if (!isDiagramBodyReflowEligible(body)) {
    return
  }
  pendingRefitBodies.add(body)
  if (batchRefitRafId) {
    return
  }
  batchRefitRafId = requestAnimationFrame(flushBatchDiagramRefit)
}

/** 窗口尺寸变化时重算所有图表外框（侧栏收起/拉宽等场景） */
const bindDiagramWindowResize = () => {
  if (diagramWindowResizeBound || typeof window === 'undefined') {
    return
  }
  diagramWindowResizeBound = true
  window.addEventListener('resize', () => {
    if (diagramWindowResizeDebounceTimer) {
      clearTimeout(diagramWindowResizeDebounceTimer)
    }
    diagramWindowResizeDebounceTimer = window.setTimeout(() => {
      diagramWindowResizeDebounceTimer = 0
      scheduleGlobalDiagramReflow()
    }, DIAGRAM_WINDOW_RESIZE_DEBOUNCE_MS)
  })
}

/** 监听图表块与 body 宽度变化，拉宽时重新收紧外框高度 */
const observeDiagramBodyResize = (body: HTMLElement) => {
  bindDiagramWindowResize()
  disconnectDiagramFitObserver(body)
  if (typeof ResizeObserver === 'undefined') {
    return
  }
  const observer = new ResizeObserver(() =>
    scheduleFitDiagramSvgReflowThrottled(body)
  )
  observer.observe(body)
  diagramFitObservers.set(body, observer)
}

/**
 * 图表渲染完成后原子切换占位态：
 * 先在 pending 状态下完成一次同步高度适配，再移除 pending，避免气泡先被 SVG 自然高度撑开。
 */
const scheduleFitDiagramSvg = (body: HTMLElement) => {
  fitDiagramSvgInBody(body)
  clearDiagramBodyPending(body)
  requestAnimationFrame(() => {
    fitDiagramSvgInBody(body)
    observeDiagramBodyResize(body)
  })
}

let diagramRuntimeLoad:
  | Promise<typeof import('./diagramMarkdownRuntime')>
  | undefined

const getDiagramRuntime = () => {
  if (!diagramRuntimeLoad) {
    diagramRuntimeLoad = import('./diagramMarkdownRuntime')
  }
  return diagramRuntimeLoad
}

const blockAbortControllers = new WeakMap<Element, AbortController>()

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true
})

const escapeHtml = (value: string) => md.utils.escapeHtml(value)

const normalizeFenceLanguage = (info?: string) =>
  (info || '').trim().split(/\s+/)[0]?.toLowerCase() || ''

/** 异步块占位：spinner + 生成中 + 跳动省略号 */
const renderGeneratingHintHtml = () =>
  [
    '<span class="md-block-generating" role="status" aria-live="polite">',
    '<span class="md-block-generating-text">生成中</span>',
    '<span class="md-block-generating-dots" aria-hidden="true">',
    '<span>.</span><span>.</span><span>.</span>',
    '</span>',
    '</span>'
  ].join('')

/** innerHTML / replaceChildren 不会清掉容器上的 pending 类，渲染成功后须显式移除 */
const clearDiagramBodyPending = (body: HTMLElement) => {
  body.classList.remove('md-block-pending')
}

const renderDiagramPlaceholder = (
  type: 'mermaid' | 'plantuml' | 'vegalite',
  source: string,
  fenceOpen = false
) => {
  const escapedSource = escapeHtml(source)
  const fenceOpenAttr = fenceOpen ? ` ${MARKDOWN_FENCE_OPEN_ATTR}="true"` : ''
  return [
    `<div class="md-diagram md-diagram-${type}" ${MARKDOWN_RENDER_ATTR}="${type}" ${MARKDOWN_REVISION_ATTR}="${MARKDOWN_RENDERER_REVISION}"${fenceOpenAttr}>`,
    `<pre class="md-diagram-source" hidden>${escapedSource}</pre>`,
    `<div class="md-diagram-body md-block-pending">${renderGeneratingHintHtml()}</div>`,
    '</div>'
  ].join('')
}

const renderHtmlPreviewPlaceholder = (source: string, fenceOpen = false) => {
  const escapedSource = escapeHtml(source)
  const fenceOpenAttr = fenceOpen ? ` ${MARKDOWN_FENCE_OPEN_ATTR}="true"` : ''
  return [
    `<div class="md-html-block" ${MARKDOWN_RENDER_ATTR}="html"${fenceOpenAttr}>`,
    `<pre class="md-diagram-source" hidden>${escapedSource}</pre>`,
    '<div class="md-html-preview-wrap md-block-pending" role="region" aria-label="HTML 预览">',
    '<iframe class="md-html-preview" sandbox="allow-same-origin allow-scripts allow-forms allow-popups" scrolling="no" title="HTML 预览"></iframe>',
    renderGeneratingHintHtml(),
    '</div>',
    '</div>'
  ].join('')
}

const defaultFence = md.renderer.rules.fence?.bind(md.renderer.rules)

const MD_CODE_COPY_ICON =
  '<svg class="md-code-copy-icon" viewBox="0 0 1024 1024" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M768 832H256c-35.3 0-64-28.7-64-64V256c0-35.3 28.7-64 64-64h512c35.3 0 64 28.7 64 64v512c0 35.3-28.7 64-64 64zM704 192H320c-17.7 0-32 14.3-32 32v448c0 17.7 14.3 32 32 32h384c17.7 0 32-14.3 32-32V224c0-17.7-14.3-32-32-32zM448 320h128v64H448v-64z"/></svg>'

const mt = (key: string, fallback: string) => t(key, undefined, fallback)

/** 普通围栏代码块：顶部语言头 + 底部安全区复制按钮 */
const wrapFenceCodeBlock = (preHtml: string, lang: string) => {
  const label = escapeHtml(lang || 'text')
  return [
    '<div class="md-code-block">',
    '<div class="md-code-block-head">',
    `<span class="md-code-lang">${label}</span>`,
    '</div>',
    preHtml,
    '<div class="md-code-block-foot">',
    `<button type="button" class="md-code-copy" aria-label="${escapeHtml(
      mt('markdownRenderer.copyCode', 'Copy code')
    )}" title="${escapeHtml(mt('markdownRenderer.copy', 'Copy'))}">`,
    MD_CODE_COPY_ICON,
    '</button>',
    '</div>',
    '</div>'
  ].join('')
}

const formatDiagnosticSection = (label: string, content: string) =>
  `[${label}]\n${content}`

const renderDiagnosticCopyButton = (content: string) => [
  '<div class="md-code-block md-diagram-error-code">',
  `<pre hidden><code>${escapeHtml(content)}</code></pre>`,
  '<div class="md-code-block-foot">',
  `<button type="button" class="md-code-copy md-diagram-error-copy" aria-label="${escapeHtml(
    mt('markdownRenderer.diagramError.copyAllDiagnostics', 'Copy diagnostics')
  )}" title="${escapeHtml(mt('markdownRenderer.copyAll', 'Copy all'))}">`,
  MD_CODE_COPY_ICON,
  `<span>${escapeHtml(
    mt('markdownRenderer.diagramError.copyAllDiagnostics', 'Copy diagnostics')
  )}</span>`,
  '</button>',
  '</div>',
  '</div>'
].join('')

const renderDiagnosticDetails = (content: string) => [
  '<details class="md-diagram-error-details">',
  `<summary class="md-diagram-error-summary">${escapeHtml(
    mt('markdownRenderer.diagramError.viewDetails', 'View error details')
  )}</summary>`,
  `<pre class="md-diagram-error-pre"><code>${escapeHtml(content)}</code></pre>`,
  '</details>'
].join('')

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const lang = normalizeFenceLanguage(token.info)

  if (lang === 'html') {
    return renderHtmlPreviewPlaceholder(token.content)
  }

  if (lang === 'mermaid') {
    return renderDiagramPlaceholder('mermaid', token.content)
  }

  if (lang === 'puml' || lang === 'plantuml') {
    return renderDiagramPlaceholder('plantuml', token.content)
  }

  if (lang === 'vega-lite' || lang === 'vegalite') {
    return renderDiagramPlaceholder('vegalite', token.content)
  }

  if (defaultFence) {
    return wrapFenceCodeBlock(
      defaultFence(tokens, idx, options, env, self),
      lang
    )
  }

  return wrapFenceCodeBlock(self.renderToken(tokens, idx, options), lang)
}

/** 从 `.md-code-block` 读取可复制文本 */
export const getMarkdownCodeBlockText = (block: Element) => {
  const pre = block.querySelector('pre')
  if (!pre) {
    return ''
  }
  return pre.querySelector('code')?.textContent ?? pre.textContent ?? ''
}

const MD_P_IMAGE_CLASS = 'md-p-image'

md.renderer.rules.paragraph_open = function () {
  return '<p style="line-height: var(--n-font-line-height-4);">'
}

md.renderer.rules.link_open = function(tokens, idx, options, env, self) {
  tokens[idx].attrPush(['target', '_blank'])
  tokens[idx].attrPush(['rel', 'noopener noreferrer'])
  return self.renderToken(tokens, idx, options)
}

/** 图片默认懒加载，减轻流式输出时主线程解码压力 */
const defaultImageRule = md.renderer.rules.image?.bind(md.renderer.rules)
if (defaultImageRule) {
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    if (token.attrIndex('loading') < 0) {
      token.attrPush(['loading', 'lazy'])
    }
    if (token.attrIndex('decoding') < 0) {
      token.attrPush(['decoding', 'async'])
    }
    return defaultImageRule(tokens, idx, options, env, self)
  }
}

md.renderer.rules.table_open = function() {
  return '<div class="md-table-wrap"><table class="md-table">'
}
md.renderer.rules.table_close = function() {
  return '</table></div>'
}
md.renderer.rules.thead_open = function() {
  return '<thead class="md-thead">'
}
md.renderer.rules.tbody_open = function() {
  return '<tbody class="md-tbody">'
}
md.renderer.rules.tr_open = function() {
  return '<tr class="md-tr">'
}
md.renderer.rules.th_open = function() {
  return '<th class="md-th">'
}
md.renderer.rules.td_open = function() {
  return '<td class="md-td">'
}

/** 流式尾段中可由 renderMarkdownBlocks 异步渲染的围栏语言 */
const ASYNC_DIAGRAM_FENCE_LANGS = new Set([
  'mermaid',
  'puml',
  'plantuml',
  'vegalite',
  'vega-lite',
  'html'
])

type OpenAsyncFenceScan = {
  lang: string
  /** opening fence 行结束后的 index（body 起点） */
  bodyStart: number
  /** opening fence 行起始 index（前缀终点） */
  prefixEnd: number
}

/** 扫描尾段 markdown，定位未闭合的 async 图表/HTML 围栏 */
const scanOpenAsyncDiagramFence = (text: string): OpenAsyncFenceScan | null => {
  if (!text?.trim()) {
    return null
  }
  let inFence = false
  let openLen = 0
  let openChar = ''
  let lang = ''
  let bodyStart = 0
  let prefixEnd = 0
  const lineRe = /^([ \t]*)(`{3,}|~{3,})(.*)$/gm
  let match: RegExpExecArray | null
  while ((match = lineRe.exec(text)) !== null) {
    const marker = match[2]
    const info = match[3].trim()
    const char = marker[0]
    const len = marker.length
    if (!inFence) {
      inFence = true
      openChar = char
      openLen = len
      lang = info.split(/\s+/)[0]?.toLowerCase() || ''
      prefixEnd = match.index
      bodyStart = match.index + match[0].length
      continue
    }
    if (char === openChar && len >= openLen && !info) {
      inFence = false
      lang = ''
    }
  }
  if (!inFence || !ASYNC_DIAGRAM_FENCE_LANGS.has(lang)) {
    return null
  }
  return { lang, bodyStart, prefixEnd }
}

/**
 * 尾段是否仍含未闭合的异步图表/HTML 围栏（markdown-it 将未闭合围栏延伸至 EOF）。
 */
export const hasOpenAsyncDiagramFence = (text: string): boolean =>
  scanOpenAsyncDiagramFence(text) !== null

/** 未闭合 async 围栏体内的源码（不含 ``` 行）；无 open 围栏时返回 null */
export const extractOpenAsyncFenceBody = (text: string): string | null => {
  const scan = scanOpenAsyncDiagramFence(text)
  if (!scan) {
    return null
  }
  const raw = text.slice(scan.bodyStart)
  return raw.startsWith('\n') ? raw.slice(1) : raw
}

const getOpenAsyncFencePrefix = (text: string): string | null => {
  const scan = scanOpenAsyncDiagramFence(text)
  if (!scan) {
    return null
  }
  return text.slice(0, scan.prefixEnd)
}

const mapFenceLangToRenderType = (
  lang: string
): 'mermaid' | 'plantuml' | 'vegalite' | 'html' | null => {
  switch (lang) {
    case 'mermaid':
      return 'mermaid'
    case 'puml':
    case 'plantuml':
      return 'plantuml'
    case 'vega-lite':
    case 'vegalite':
      return 'vegalite'
    case 'html':
      return 'html'
    default:
      return null
  }
}

const buildOpenFencePlaceholderHtml = (
  scan: OpenAsyncFenceScan,
  body: string,
  fenceOpen = true
): string => {
  const type = mapFenceLangToRenderType(scan.lang)
  if (!type) {
    return ''
  }
  if (type === 'html') {
    return renderHtmlPreviewPlaceholder(body, fenceOpen)
  }
  return renderDiagramPlaceholder(type, body, fenceOpen)
}

const renderOpenFencePrefixHtml = (
  markdown: string,
  scan: OpenAsyncFenceScan
): string => {
  const prefix = markdown.slice(0, scan.prefixEnd)
  return prefix.trim()
    ? md.render(normalizeMarkdownRepoFileUrls(prefix))
    : ''
}

const buildOpenFenceTailHtml = (
  markdown: string,
  scan: OpenAsyncFenceScan
): string => {
  const body = extractOpenAsyncFenceBody(markdown) ?? ''
  return (
    renderOpenFencePrefixHtml(markdown, scan) +
    buildOpenFencePlaceholderHtml(scan, body, true)
  )
}

/** 未闭合 async 围栏：仅 markdown-it 前缀，body 手工占位，避免全文 parse */
const renderMarkdownWithOpenFenceSupport = (markdown: string): string => {
  const normalized = normalizeMarkdownRepoFileUrls(markdown || '')
  const scan = scanOpenAsyncDiagramFence(normalized)
  if (!scan) {
    return md.render(normalized)
  }
  return buildOpenFenceTailHtml(normalized, scan)
}

export const renderMarkdown = (markdown?: string) =>
  renderMarkdownWithOpenFenceSupport(markdown || '')

const buildMarkdownHtmlCacheKey = (markdown: string, cacheKey?: string) =>
  `${MARKDOWN_RENDERER_REVISION}:${cacheKey ?? markdown}`

/** 带 LRU 的 Markdown HTML 缓存，避免 Vue 重渲染重复 markdown-it 解析 */
export const renderMarkdownCached = (
  markdown?: string,
  cacheKey?: string
) => {
  const normalized = normalizeMarkdownRepoFileUrls(markdown || '')
  const key = buildMarkdownHtmlCacheKey(normalized, cacheKey)
  const cached = markdownHtmlCache.get(key)
  if (cached !== undefined) {
    return cached
  }
  const html = renderMarkdownWithOpenFenceSupport(normalized)
  if (markdownHtmlCache.size >= MARKDOWN_HTML_CACHE_MAX_ENTRIES) {
    const oldest = markdownHtmlCache.keys().next().value
    if (oldest) {
      markdownHtmlCache.delete(oldest)
    }
  }
  markdownHtmlCache.set(key, html)
  return html
}

export const clearMarkdownHtmlCache = () => {
  markdownHtmlCache.clear()
}

const hashDiagramSource = (source: string) => {
  let h = 2166136261
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

const normalizeDiagramSourceForCache = (type: string, source: string) => {
  if (type === 'mermaid') {
    return normalizeMermaidSource(source)
  }
  return source.trim()
}

const buildDiagramMarkupCacheKey = (
  scope: string,
  type: string,
  source: string
) =>
  `${scope}:${MARKDOWN_RENDERER_REVISION}:${type}:${hashDiagramSource(
    normalizeDiagramSourceForCache(type, source)
  )}`

const getDiagramMarkupCache = (
  scope: string,
  type: string,
  source: string
): string | undefined => {
  return diagramMarkupCache.get(buildDiagramMarkupCacheKey(scope, type, source))
}

const touchDiagramMarkupCacheEntry = (key: string, markup: string) => {
  if (diagramMarkupCache.has(key)) {
    diagramMarkupCache.delete(key)
  }
  diagramMarkupCache.set(key, markup)
  while (diagramMarkupCache.size > DIAGRAM_MARKUP_CACHE_MAX_ENTRIES) {
    const oldest = diagramMarkupCache.keys().next().value
    if (!oldest) {
      break
    }
    diagramMarkupCache.delete(oldest)
    const sessionKey = oldest.split(':')[0]
    const count = diagramMarkupCacheSessionCounts.get(sessionKey)
    if (count !== undefined) {
      if (count <= 1) {
        diagramMarkupCacheSessionCounts.delete(sessionKey)
      } else {
        diagramMarkupCacheSessionCounts.set(sessionKey, count - 1)
      }
    }
  }
}

const setDiagramMarkupCache = (
  scope: string,
  type: string,
  source: string,
  markup: string
) => {
  const key = buildDiagramMarkupCacheKey(scope, type, source)
  const sessionCount = diagramMarkupCacheSessionCounts.get(scope) ?? 0
  if (!diagramMarkupCache.has(key) && sessionCount >= DIAGRAM_MARKUP_CACHE_MAX_PER_SESSION) {
    return
  }
  if (!diagramMarkupCache.has(key)) {
    diagramMarkupCacheSessionCounts.set(scope, sessionCount + 1)
  }
  touchDiagramMarkupCacheEntry(key, markup)
}

/** 移除会话时清理由该会话写入的图表 markup 缓存 */
export const clearDiagramMarkupCacheForSession = (scope: string) => {
  diagramMarkupCacheSessionCounts.delete(scope)
  for (const key of [...diagramMarkupCache.keys()]) {
    if (key.startsWith(`${scope}:`)) {
      diagramMarkupCache.delete(key)
    }
  }
}

export const getMarkdownRenderGeneration = () => markdownRenderGeneration

const isMarkdownRenderGenerationCurrent = (generation: number) =>
  generation === markdownRenderGeneration

const isPendingAsyncMarkdownBlock = (block: Element): boolean => {
  const type = block.getAttribute(MARKDOWN_RENDER_ATTR)
  if (!type || !ASYNC_DIAGRAM_FENCE_LANGS.has(type)) {
    return false
  }
  return block.querySelector('.md-block-pending') !== null
}

const findPendingAsyncMarkdownBlock = (root: ParentNode): Element | null => {
  for (const block of root.querySelectorAll(`[${MARKDOWN_RENDER_ATTR}]`)) {
    if (isPendingAsyncMarkdownBlock(block)) {
      return block
    }
  }
  return null
}

const childNodesBefore = (parent: Element, anchor: Element): ChildNode[] => {
  const nodes: ChildNode[] = []
  for (const node of parent.childNodes) {
    if (node === anchor) {
      break
    }
    nodes.push(node)
  }
  return nodes
}

const serializeChildNodes = (nodes: ChildNode[]): string =>
  nodes
    .map((node) =>
      node instanceof Element ? node.outerHTML : node.textContent ?? ''
    )
    .join('')

const syncBlockSource = (target: Element, source: Element) => {
  const nextSource =
    source.querySelector('.md-diagram-source')?.textContent ?? ''
  const targetSource = target.querySelector('.md-diagram-source')
  if (targetSource) {
    targetSource.textContent = nextSource
  }
}

const syncChildNodesBefore = (
  root: HTMLElement,
  oldAnchor: Element,
  template: HTMLElement,
  newAnchor: Element
) => {
  const oldBefore = childNodesBefore(root, oldAnchor)
  const newBefore = childNodesBefore(template, newAnchor)
  if (serializeChildNodes(oldBefore) === serializeChildNodes(newBefore)) {
    return
  }
  oldBefore.forEach((node) => node.remove())
  const fragment = document.createDocumentFragment()
  newBefore.forEach((node) => fragment.appendChild(node.cloneNode(true)))
  root.insertBefore(fragment, oldAnchor)
}

const removeChildNodesAfter = (root: HTMLElement, anchor: Element) => {
  let next = anchor.nextSibling
  while (next) {
    const toRemove = next
    next = next.nextSibling
    toRemove.remove()
  }
}

const replaceRootChildren = (root: HTMLElement, template: HTMLElement) => {
  root.replaceChildren(
    ...Array.from(template.childNodes).map((node) => node.cloneNode(true))
  )
}

/** 各流式尾段容器最近一次渲染的 markdown 原文，用于渲染前短路去重 */
const lastStreamTailMarkdown = new WeakMap<HTMLElement, string>()

const stripStreamTailEllipsis = (stored: string) =>
  stored.endsWith('...') ? stored.slice(0, -3) : stored

const syncBlockSourceText = (block: Element, source: string) => {
  const targetSource = block.querySelector('.md-diagram-source')
  if (targetSource) {
    targetSource.textContent = source
  }
}

/** 流式尾段 open fence：仅更新前缀 DOM + placeholder，不跑全文 markdown-it */
const buildOpenFenceTailDom = (
  root: HTMLElement,
  markdown: string,
  scan: OpenAsyncFenceScan,
  oldPending: Element | null
): void => {
  const nextHtml = buildOpenFenceTailHtml(markdown, scan)
  const template = document.createElement('div')
  template.innerHTML = nextHtml
  const newPending = findPendingAsyncMarkdownBlock(template)

  if (oldPending && newPending) {
    syncChildNodesBefore(root, oldPending, template, newPending)
    syncBlockSource(oldPending, newPending)
    removeChildNodesAfter(root, oldPending)
    return
  }

  root.innerHTML = nextHtml
}

/**
 * 流式尾段就地更新：pending 图表/HTML 占位节点保留在文档中，仅同步前缀与 hidden source，
 * 避免 v-html 整段替换导致流光动画重启。
 *
 * 注意：尾段每帧都在增长、内容几乎不重复，绝不能走 renderMarkdownCached——
 * 否则 LRU 会被数百份「接近全文的尾段快照」（原文 + HTML 双份大字符串）占满，
 * 既挤掉稳定消息的缓存，长回答时还会导致内存溢出。
 */
export const updateStreamTailSegmentInPlace = (
  root: HTMLElement,
  markdown: string,
  appendEllipsis = false
): void => {
  if (!root.isConnected) {
    return
  }
  const text = markdown + (appendEllipsis ? '...' : '')
  if (lastStreamTailMarkdown.get(root) === text) {
    return
  }

  const scan = scanOpenAsyncDiagramFence(markdown)
  if (scan) {
    const oldPending = findPendingAsyncMarkdownBlock(root)
    const body = extractOpenAsyncFenceBody(markdown)
    const prevStored = lastStreamTailMarkdown.get(root)
    const prevMarkdown = prevStored ? stripStreamTailEllipsis(prevStored) : null
    const prevPrefix = prevMarkdown ? getOpenAsyncFencePrefix(prevMarkdown) : null
    const prefix = getOpenAsyncFencePrefix(markdown)
    if (
      oldPending &&
      body !== null &&
      prevMarkdown !== null &&
      prefix !== null &&
      prevPrefix !== null &&
      prefix === prevPrefix &&
      markdown.startsWith(prevMarkdown)
    ) {
      syncBlockSourceText(oldPending, body)
      lastStreamTailMarkdown.set(root, text)
      return
    }

    buildOpenFenceTailDom(root, markdown, scan, oldPending)
    lastStreamTailMarkdown.set(root, text)
    normalizeMarkdownImageParagraphs(root)
    return
  }

  const oldPending = findPendingAsyncMarkdownBlock(root)
  const nextHtml = renderMarkdown(text)

  const template = document.createElement('div')
  template.innerHTML = nextHtml

  const newPending = findPendingAsyncMarkdownBlock(template)

  if (oldPending && newPending) {
    syncChildNodesBefore(root, oldPending, template, newPending)
    syncBlockSource(oldPending, newPending)
    removeChildNodesAfter(root, oldPending)
    lastStreamTailMarkdown.set(root, text)
    normalizeMarkdownImageParagraphs(root)
    return
  }

  root.innerHTML = nextHtml
  lastStreamTailMarkdown.set(root, text)
  normalizeMarkdownImageParagraphs(root)
}

let streamTailUpdateRafId = 0
let streamTailThrottleTimer = 0
let streamTailLastRunAt = 0
let pendingStreamTailUpdate:
  | {
      root: HTMLElement
      markdown: string
      appendEllipsis: boolean
    }
  | null = null

const flushPendingStreamTailUpdate = () => {
  streamTailUpdateRafId = 0
  streamTailThrottleTimer = 0
  const pending = pendingStreamTailUpdate
  pendingStreamTailUpdate = null
  if (!pending || !pending.root.isConnected) {
    return
  }
  streamTailLastRunAt = Date.now()
  updateStreamTailSegmentInPlace(
    pending.root,
    pending.markdown,
    pending.appendEllipsis
  )
}

/** rAF + 时间节流合并流式 token，避免每帧对增长中的尾段跑完整 markdown-it + innerHTML */
export const scheduleUpdateStreamTailSegmentInPlace = (
  root: HTMLElement,
  markdown: string,
  appendEllipsis = false,
  immediate = false
) => {
  if (!root.isConnected) {
    return
  }
  pendingStreamTailUpdate = { root, markdown, appendEllipsis }
  if (immediate) {
    if (streamTailUpdateRafId) {
      cancelAnimationFrame(streamTailUpdateRafId)
      streamTailUpdateRafId = 0
    }
    if (streamTailThrottleTimer) {
      clearTimeout(streamTailThrottleTimer)
      streamTailThrottleTimer = 0
    }
    flushPendingStreamTailUpdate()
    return
  }

  const scheduleAfterThrottle = () => {
    if (streamTailUpdateRafId) {
      return
    }
    streamTailUpdateRafId = requestAnimationFrame(flushPendingStreamTailUpdate)
  }

  const elapsed = Date.now() - streamTailLastRunAt
  if (elapsed >= STREAM_TAIL_MIN_INTERVAL_MS) {
    scheduleAfterThrottle()
    return
  }

  if (streamTailThrottleTimer) {
    return
  }
  streamTailThrottleTimer = window.setTimeout(() => {
    streamTailThrottleTimer = 0
    scheduleAfterThrottle()
  }, STREAM_TAIL_MIN_INTERVAL_MS - elapsed)
}

/** 聊天页 idle 预加载图表 Worker 运行时，降低首图冷启动延迟 */
export const preloadDiagramRuntimes = () => {
  void getDiagramRuntime().then((runtime) => runtime.preloadDiagramRuntimes())
}

/** 异步渲染 Markdown 图表块时的选项 */
export type RenderMarkdownBlocksOptions = {
  /**
   * 为 true 时，仅跳过仍处于流式尾段（带 data-md-stream-tail 标记的容器内、围栏尚未闭合）的
   * mermaid/plantuml/vegalite/html 块；已闭合的块照常立即渲染。用于 LLM 流式输出避免逐 token 重渲染抽搐。
   */
  deferDiagrams?: boolean
  /** 并发渲染图表块上限，默认 2 */
  concurrency?: number
  /** 视口外后台渲染并发上限，默认 1 */
  backgroundConcurrency?: number
  /** 滚动容器，用于视口优先调度（ChatView / MdViewer 传入） */
  scrollRoot?: Element | null
  /** IntersectionObserver 预取边距，默认提前约 1~2 屏 */
  prefetchRootMargin?: string
  /** 为 false 时按 DOM 顺序全量渲染（便于测试/回退），默认 true */
  lazy?: boolean
  /** 会话 key，启用已渲染图表 markup 缓存（ChatView 传入） */
  diagramCacheScope?: string
}

const DEFAULT_DIAGRAM_RENDER_CONCURRENCY = 2
const DEFAULT_BACKGROUND_RENDER_CONCURRENCY = 2
const MARKDOWN_MIN_PREFETCH_PX = 2400
const MARKDOWN_PREFETCH_VIEWPORT_MULTIPLIER = 2.5
const DEFAULT_PREFETCH_ROOT_MARGIN = `${MARKDOWN_MIN_PREFETCH_PX}px 0px`
const IDLE_BACKGROUND_TIMEOUT_MS = 2000

/** 按容器高度计算 Markdown 异步块预取区（约 2.5 屏，至少 2400px） */
export const buildMarkdownPrefetchRootMargin = (scrollRoot: Element | null) => {
  const viewportHeight =
    scrollRoot instanceof HTMLElement
      ? scrollRoot.clientHeight
      : typeof window !== 'undefined'
        ? window.innerHeight
        : 800
  const prefetchPx = Math.max(
    MARKDOWN_MIN_PREFETCH_PX,
    Math.ceil(viewportHeight * MARKDOWN_PREFETCH_VIEWPORT_MULTIPLIER)
  )
  return `${prefetchPx}px 0px`
}

/** MdViewer 复用通用预取策略，保留旧导出名供调用方使用 */
export const buildMdViewerPrefetchRootMargin = buildMarkdownPrefetchRootMargin

/** 待渲染块：未渲染或 revision 落后于当前渲染器版本 */
const buildPendingBlocksSelector = () =>
  `[${MARKDOWN_RENDER_ATTR}]:not([${MARKDOWN_RENDERED_ATTR}="true"]), ` +
  `[${MARKDOWN_RENDER_ATTR}][${MARKDOWN_RENDERED_ATTR}="true"]:not([${MARKDOWN_REVISION_ATTR}="${MARKDOWN_RENDERER_REVISION}"])`

const collectCandidateMarkdownBlocks = (root: ParentNode | Element): Element[] =>
  Array.from(root.querySelectorAll<Element>(buildPendingBlocksSelector()))

export const hasPendingMarkdownBlocks = (
  root: ParentNode | Element,
  options?: RenderMarkdownBlocksOptions
): boolean =>
  collectCandidateMarkdownBlocks(root).some((block) =>
    isBlockPendingRender(block, options)
  )

const isHeavyMarkdownBlock = (block: Element): boolean => {
  const type = block.getAttribute(MARKDOWN_RENDER_ATTR)
  return type === 'html' || type === 'plantuml'
}

const isBlockPendingRender = (
  block: Element,
  options?: RenderMarkdownBlocksOptions
): boolean => {
  const type = block.getAttribute(MARKDOWN_RENDER_ATTR)
  const isAsyncBlock =
    type === 'mermaid' ||
    type === 'plantuml' ||
    type === 'vegalite' ||
    type === 'html'
  // 围栏未闭合 / 流式尾段 / 源码未就绪：占位块故意不渲染，不能算 pending（否则调度器死循环）
  if (isAsyncBlock && !isAsyncDiagramBlockReady(block, options)) {
    return false
  }
  if (block.classList.contains('md-diagram-error')) {
    return false
  }
  const alreadyRendered = block.getAttribute(MARKDOWN_RENDERED_ATTR) === 'true'
  if (!alreadyRendered) {
    return true
  }
  return block.getAttribute(MARKDOWN_REVISION_ATTR) !== MARKDOWN_RENDERER_REVISION
}

const parsePrefetchMarginPx = (rootMargin: string): number => {
  const match = rootMargin.match(/(-?\d+(?:\.\d+)?)px/)
  return match ? Number.parseFloat(match[1]) : 800
}

const getScrollRootRect = (scrollRoot: Element | null) => {
  if (scrollRoot) {
    return scrollRoot.getBoundingClientRect()
  }
  return {
    top: 0,
    bottom: typeof window !== 'undefined' ? window.innerHeight : 800,
    left: 0,
    right: typeof window !== 'undefined' ? window.innerWidth : 1200
  }
}

/** 0=视口内，1=下方预取，2=上方预取，3=远离视口 */
const getBlockViewportPriority = (
  block: Element,
  scrollRoot: Element | null,
  prefetchPx: number
): number => {
  const rootRect = getScrollRootRect(scrollRoot)
  const blockRect = block.getBoundingClientRect()

  if (blockRect.bottom >= rootRect.top && blockRect.top <= rootRect.bottom) {
    return 0
  }
  if (
    blockRect.top > rootRect.bottom &&
    blockRect.top <= rootRect.bottom + prefetchPx
  ) {
    return 1
  }
  if (
    blockRect.bottom < rootRect.top &&
    blockRect.bottom >= rootRect.top - prefetchPx
  ) {
    return 2
  }
  return 3
}

const getPendingBlockSurface = (block: Element): HTMLElement | null =>
  block.querySelector<HTMLElement>('.md-diagram-body.md-block-pending') ??
  block.querySelector<HTMLElement>('.md-html-preview-wrap.md-block-pending')

const updateBlockOffscreenAttr = (block: Element, priority: number) => {
  const surface = getPendingBlockSurface(block)
  if (!surface) {
    return
  }
  if (priority >= 3) {
    surface.setAttribute(MARKDOWN_OFFSCREEN_ATTR, '')
  } else {
    surface.removeAttribute(MARKDOWN_OFFSCREEN_ATTR)
  }
}

type ViewportObserverState = {
  observer: IntersectionObserver
  blocks: Set<Element>
  rootMargin: string
}

const viewportObserverStates = new WeakMap<Element, ViewportObserverState>()
let viewportDrainHandler: (() => void) | null = null

const ensureViewportObserver = (
  scrollRoot: Element,
  rootMargin: string
): ViewportObserverState => {
  let state = viewportObserverStates.get(scrollRoot)
  if (state && state.rootMargin !== rootMargin) {
    state.observer.disconnect()
    viewportObserverStates.delete(scrollRoot)
    state = undefined
  }
  if (state) {
    return state
  }
  state = {
    blocks: new Set(),
    rootMargin,
    observer: new IntersectionObserver(
      (entries) => {
        let shouldDrain = false
        for (const entry of entries) {
          const block = entry.target
          if (!(block instanceof Element)) {
            continue
          }
          if (!isBlockPendingRender(block)) {
            getPendingBlockSurface(block)?.removeAttribute(MARKDOWN_OFFSCREEN_ATTR)
            continue
          }
          const surface = getPendingBlockSurface(block)
          if (entry.isIntersecting) {
            surface?.removeAttribute(MARKDOWN_OFFSCREEN_ATTR)
            shouldDrain = true
          } else {
            surface?.setAttribute(MARKDOWN_OFFSCREEN_ATTR, '')
          }
        }
        if (shouldDrain) {
          viewportDrainHandler?.()
        }
      },
      { root: scrollRoot, rootMargin, threshold: 0 }
    )
  }
  viewportObserverStates.set(scrollRoot, state)
  return state
}

const observeBlockForViewport = (
  block: Element,
  scrollRoot: Element,
  rootMargin: string
) => {
  const state = ensureViewportObserver(scrollRoot, rootMargin)
  if (state.blocks.has(block)) {
    return
  }
  state.blocks.add(block)
  state.observer.observe(block)
}

const unobserveBlockForViewport = (block: Element, scrollRoot: Element) => {
  const state = viewportObserverStates.get(scrollRoot)
  if (!state || !state.blocks.has(block)) {
    return
  }
  state.blocks.delete(block)
  state.observer.unobserve(block)
}

/** 调度结束后断开 IO，避免滚动继续触发 drain */
const cleanupViewportScheduling = (
  scrollRoot: Element | null,
  blocks: Element[],
  handler: () => void
) => {
  if (viewportDrainHandler === handler) {
    viewportDrainHandler = null
  }
  if (!scrollRoot) {
    return
  }
  const state = viewportObserverStates.get(scrollRoot)
  if (!state) {
    return
  }
  for (const block of blocks) {
    if (!state.blocks.has(block)) {
      continue
    }
    state.blocks.delete(block)
    state.observer.unobserve(block)
  }
}

const scheduleIdle = (fn: () => void) => {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(fn, { timeout: IDLE_BACKGROUND_TIMEOUT_MS })
  } else {
    setTimeout(fn, 0)
  }
}

const renderWithViewportScheduling = async (
  blocks: Element[],
  options: RenderMarkdownBlocksOptions,
  renderGeneration = markdownRenderGeneration
): Promise<HTMLElement[]> => {
  const scrollRoot = options.scrollRoot ?? null
  const prefetchRootMargin =
    options.prefetchRootMargin ?? DEFAULT_PREFETCH_ROOT_MARGIN
  const prefetchPx = parsePrefetchMarginPx(prefetchRootMargin)
  const maxVisibleConcurrency =
    options.concurrency ?? DEFAULT_DIAGRAM_RENDER_CONCURRENCY
  const maxBackgroundConcurrency =
    options.backgroundConcurrency ?? DEFAULT_BACKGROUND_RENDER_CONCURRENCY

  const remaining = new Set(
    blocks.filter((block) => isBlockPendingRender(block, options))
  )
  const inFlight = new Set<Element>()
  let heavyInFlight = 0
  const maxHeavyConcurrent = 1
  const bodiesToRefit: HTMLElement[] = []
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const getPendingBlocks = () =>
    [...remaining].filter((block) => isBlockPendingRender(block, options))

  const countInFlightVisible = () =>
    [...inFlight].filter(
      (block) =>
        getBlockViewportPriority(block, scrollRoot, prefetchPx) < 3
    ).length

  const countInFlightBackground = () =>
    [...inFlight].filter(
      (block) =>
        getBlockViewportPriority(block, scrollRoot, prefetchPx) >= 3
    ).length

  const maybeFinish = () => {
    if (inFlight.size > 0) {
      return
    }
    const pending = getPendingBlocks()
    if (pending.length === 0) {
      resolveDone()
      return
    }
    const hasVisiblePending = pending.some(
      (block) => getBlockViewportPriority(block, scrollRoot, prefetchPx) < 3
    )
    // 可见/预取队列已排空且禁止后台渲染时，本 pass 结束，避免 await done 永久挂起
    if (!hasVisiblePending && maxBackgroundConcurrency === 0) {
      resolveDone()
    }
  }

  const startBlock = (block: Element) => {
    if (!isMarkdownRenderGenerationCurrent(renderGeneration)) {
      return
    }
    if (!isBlockPendingRender(block, options)) {
      remaining.delete(block)
      return
    }
    if (inFlight.has(block)) {
      return
    }
    if (isHeavyMarkdownBlock(block) && heavyInFlight >= maxHeavyConcurrent) {
      return
    }
    if (isHeavyMarkdownBlock(block)) {
      heavyInFlight++
    }
    inFlight.add(block)
    void renderBlock(block, options, renderGeneration)
      .then((body) => {
        if (!isMarkdownRenderGenerationCurrent(renderGeneration)) {
          return
        }
        if (body) {
          bodiesToRefit.push(body)
        }
        if (!isBlockPendingRender(block, options)) {
          remaining.delete(block)
          getPendingBlockSurface(block)?.removeAttribute(MARKDOWN_OFFSCREEN_ATTR)
          if (scrollRoot) {
            unobserveBlockForViewport(block, scrollRoot)
          }
        }
      })
      .finally(() => {
        if (isHeavyMarkdownBlock(block)) {
          heavyInFlight = Math.max(0, heavyInFlight - 1)
        }
        inFlight.delete(block)
        if (
          block.getAttribute(MARKDOWN_RENDERED_ATTR) === 'true' ||
          block.classList.contains('md-diagram-error')
        ) {
          remaining.delete(block)
        }
        scheduleDrain()
        maybeFinish()
      })
  }

  const drainBackground = () => {
    if (!isMarkdownRenderGenerationCurrent(renderGeneration)) {
      return
    }
    const pending = getPendingBlocks().filter((block) => !inFlight.has(block))
    const backgroundPending = pending.filter(
      (block) =>
        getBlockViewportPriority(block, scrollRoot, prefetchPx) >= 3
    )
    let runningBackground = countInFlightBackground()
    for (const block of backgroundPending) {
      if (runningBackground >= maxBackgroundConcurrency) {
        break
      }
      runningBackground++
      startBlock(block)
    }
    maybeFinish()
  }

  const scheduleDrain = () => {
    if (!isMarkdownRenderGenerationCurrent(renderGeneration)) {
      resolveDone()
      return
    }
    for (const block of getPendingBlocks()) {
      const priority = getBlockViewportPriority(block, scrollRoot, prefetchPx)
      updateBlockOffscreenAttr(block, priority)
    }

    const pending = getPendingBlocks().filter((block) => !inFlight.has(block))
    if (pending.length === 0) {
      maybeFinish()
      return
    }

    pending.sort(
      (a, b) =>
        getBlockViewportPriority(a, scrollRoot, prefetchPx) -
        getBlockViewportPriority(b, scrollRoot, prefetchPx)
    )

    let runningVisible = countInFlightVisible()

    for (const block of pending) {
      const priority = getBlockViewportPriority(block, scrollRoot, prefetchPx)
      if (priority >= 3) {
        continue
      }
      if (runningVisible >= maxVisibleConcurrency) {
        break
      }
      runningVisible++
      startBlock(block)
    }

    const hasVisiblePending = pending.some(
      (block) =>
        getBlockViewportPriority(block, scrollRoot, prefetchPx) < 3
    )
    const hasBackgroundPending = pending.some(
      (block) =>
        getBlockViewportPriority(block, scrollRoot, prefetchPx) >= 3
    )

    if (hasBackgroundPending) {
      if (!hasVisiblePending) {
        drainBackground()
      } else if (runningVisible >= maxVisibleConcurrency) {
        scheduleIdle(drainBackground)
      }
    }
  }

  viewportDrainHandler = scheduleDrain

  if (scrollRoot && typeof IntersectionObserver !== 'undefined') {
    ensureViewportObserver(scrollRoot, prefetchRootMargin)
    for (const block of blocks) {
      observeBlockForViewport(block, scrollRoot, prefetchRootMargin)
    }
  }

  scheduleDrain()
  await done
  cleanupViewportScheduling(scrollRoot, blocks, scheduleDrain)
  return bodiesToRefit
}

const mapWithConcurrency = async <T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
) => {
  if (items.length === 0) {
    return
  }
  const concurrency = Math.max(1, limit)
  const executing = new Set<Promise<void>>()
  for (const item of items) {
    const task = fn(item).finally(() => {
      executing.delete(task)
    })
    executing.add(task)
    if (executing.size >= concurrency) {
      await Promise.race(executing)
    }
  }
  await Promise.all(executing)
}

const refitDiagramBodies = (bodies: HTMLElement[]) => {
  bodies.forEach((body) => {
    scheduleFitDiagramSvgReflow(body)
  })
}

const getSourceFromBlock = (block: Element) =>
  block.querySelector<HTMLElement>('.md-diagram-source')?.textContent || ''

/** 读取 HTML 预览块源码（隐藏 pre） */
export const getMarkdownHtmlBlockSource = (block: Element) =>
  getSourceFromBlock(block)

/** 构建 HTML 预览 iframe 的 srcdoc */
export const buildMarkdownHtmlPreviewSrcdoc = (source: string) =>
  buildHtmlPreviewDocument(source)

let textMeasureCanvas: HTMLCanvasElement | undefined

/** 解析 Mermaid text 节点 transform 中的 translate(x, y)。 */
const parseSvgTranslate = (transform: string) => {
  const match = transform.match(
    /translate\(\s*([-\d.]+)(?:[,\s]+([-\d.]+))?\s*\)/
  )
  if (!match) {
    return null
  }
  return {
    x: Number.parseFloat(match[1]),
    y: Number.parseFloat(match[2] ?? '0')
  }
}

const measureSvgTextWidth = (text: string, fontSize: number) => {
  if (typeof document === 'undefined') {
    return text.length * fontSize * 0.6
  }
  if (!textMeasureCanvas) {
    textMeasureCanvas = document.createElement('canvas')
  }
  const ctx = textMeasureCanvas.getContext('2d')
  if (!ctx) {
    return text.length * fontSize * 0.6
  }
  ctx.font = `${fontSize}px ${DIAGRAM_FONT_FAMILY}`
  return ctx.measureText(text).width
}

/** 按最大宽度将标签拆成多行（中文逐字、英文按词）。 */
const wrapLabelTextToLines = (
  text: string,
  maxWidth: number,
  fontSize: number
) => {
  if (!text || maxWidth <= 0) {
    return [text]
  }
  if (measureSvgTextWidth(text, fontSize) <= maxWidth) {
    return [text]
  }

  const lines: string[] = []
  let current = ''
  const flush = () => {
    if (current) {
      lines.push(current)
      current = ''
    }
  }

  for (const segment of text.split(/(\s+)/).filter((part) => part.length > 0)) {
    if (/^\s+$/.test(segment)) {
      const trial = current + segment
      if (measureSvgTextWidth(trial, fontSize) <= maxWidth) {
        current = trial
      } else {
        flush()
      }
      continue
    }

    for (const char of segment) {
      const trial = current + char
      if (measureSvgTextWidth(trial, fontSize) > maxWidth && current) {
        flush()
        current = char
      } else {
        current = trial
      }
    }
  }
  flush()
  return lines.length ? lines : [text]
}

/** 估算竖向 xychart 每个类目在 X 轴下的可用标签宽度。 */
const getVerticalXychartLabelSlotWidth = (svg: SVGElement) => {
  const labels = Array.from(
    svg.querySelectorAll<SVGTextElement>('g.bottom-axis g.label text')
  )
  if (!labels.length) {
    return 72
  }

  const xs = labels
    .map((node) => parseSvgTranslate(node.getAttribute('transform') || '')?.x)
    .filter((x): x is number => typeof x === 'number' && !Number.isNaN(x))
    .sort((a, b) => a - b)

  if (xs.length >= 2) {
    const gaps: number[] = []
    for (let i = 1; i < xs.length; i++) {
      gaps.push(xs[i] - xs[i - 1])
    }
    const medianGap = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
    return Math.max(48, medianGap * 0.88)
  }

  const viewBox = svg.getAttribute('viewBox')
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every((n) => !Number.isNaN(n))) {
      return Math.max(48, (parts[2] / labels.length) * 0.75)
    }
  }

  return 72
}

const applyWrappedLabelTspans = (
  textEl: SVGTextElement,
  lines: string[],
  fontSize: number
) => {
  const lineHeight = fontSize * XYCHART_LABEL_LINE_HEIGHT_RATIO
  while (textEl.firstChild) {
    textEl.removeChild(textEl.firstChild)
  }
  lines.forEach((line, index) => {
    const tspan = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'tspan'
    )
    tspan.setAttribute('x', '0')
    tspan.setAttribute('dy', index === 0 ? '0' : `${lineHeight}px`)
    tspan.textContent = line
    textEl.appendChild(tspan)
  })
}

/** 竖向 xychart：底部横向类目标签超宽时换行（tspan）。 */
const wrapXychartVerticalCategoryLabels = (svg: SVGElement) => {
  const maxWidth = getVerticalXychartLabelSlotWidth(svg)
  svg.querySelectorAll<SVGTextElement>('g.bottom-axis g.label text').forEach(
    (textEl) => {
      const raw = textEl.textContent?.trim()
      if (!raw) {
        return
      }
      const fontSize =
        Number.parseFloat(textEl.getAttribute('font-size') || '') || 14
      const lines = wrapLabelTextToLines(raw, maxWidth, fontSize)
      if (lines.length <= 1) {
        return
      }
      applyWrappedLabelTspans(textEl, lines, fontSize)
    }
  )
}

/** 换行后扩展 SVG 底部空间（布局完成后再测量）。 */
const expandXychartViewBoxForWrappedLabels = (svg: SVGElement) => {
  const viewBox = svg.getAttribute('viewBox')
  if (!viewBox) {
    return false
  }
  const parts = viewBox
    .trim()
    .split(/[\s,]+/)
    .map((value) => Number(value))
  if (parts.length !== 4 || parts.some((value) => Number.isNaN(value))) {
    return false
  }
  const [minX, minY, width, height] = parts
  let maxExtent = minY + height

  try {
    const fullBox = (svg as SVGSVGElement).getBBox()
    maxExtent = Math.max(
      maxExtent,
      fullBox.y + fullBox.height + XYCHART_WRAPPED_LABEL_BOTTOM_PAD
    )
  } catch {
    /* 忽略 */
  }

  svg.querySelectorAll('g.bottom-axis g.label text').forEach((node) => {
    if (!(node instanceof SVGTextElement)) {
      return
    }
    try {
      const box = node.getBBox()
      maxExtent = Math.max(
        maxExtent,
        box.y + box.height + XYCHART_WRAPPED_LABEL_BOTTOM_PAD
      )
    } catch {
      /* 未布局完成时忽略 */
    }
  })

  const neededHeight = Math.ceil(maxExtent - minY)
  if (neededHeight <= height) {
    return false
  }

  const heightScale = neededHeight / height
  svg.setAttribute('viewBox', `${minX} ${minY} ${width} ${neededHeight}`)

  const widthAttr = Number.parseFloat(svg.getAttribute('width') || '')
  const heightAttr = Number.parseFloat(svg.getAttribute('height') || '')
  if (widthAttr > 0 && heightAttr > 0) {
    svg.setAttribute('width', String(Math.ceil(widthAttr * heightScale)))
    svg.setAttribute('height', String(Math.ceil(heightAttr * heightScale)))
  } else if (heightAttr > 0) {
    svg.setAttribute('height', String(Math.ceil(heightAttr * heightScale)))
  } else {
    svg.setAttribute('height', String(neededHeight))
  }

  return true
}

/** 竖向图：换行 → 扩 viewBox → 按实际高度适配容器。 */
const scheduleVerticalXychartLabelLayout = (
  body: HTMLElement,
  svg: SVGElement
) => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      expandXychartViewBoxForWrappedLabels(svg)
      fitDiagramSvgInBody(body)
      observeDiagramBodyResize(body)
    })
  })
}

/** 按系列索引统一柱/条填充色，横竖向渲染结果一致。 */
const applyXychartBarColors = (svg: SVGElement) => {
  svg.querySelectorAll('g[class*="bar-plot"]').forEach((group) => {
    const className =
      group instanceof SVGElement
        ? group.className.baseVal || group.getAttribute('class') || ''
        : ''
    const indexMatch = className.match(/bar-plot-(\d+)/)
    const paletteIndex = indexMatch
      ? Number.parseInt(indexMatch[1], 10)
      : 0
    const fill =
      DIAGRAM_COLOR_PALETTE[
      paletteIndex % DIAGRAM_COLOR_PALETTE.length
        ]
    group.querySelectorAll('rect').forEach((rect) => {
      rect.setAttribute('fill', fill)
      rect.setAttribute('stroke', fill)
    })
  })
}

/** 为横向多类目 xychart 标记样式类并拉高最小高度。 */
const applyXychartDiagramPresentation = (
  block: Element,
  body: HTMLElement,
  source: string
) => {
  if (!isXychartSource(source)) {
    return
  }
  block.classList.add('md-diagram-xychart')
  if (isXychartHorizontal(source)) {
    block.classList.add('md-diagram-xychart--horizontal')
  } else {
    block.classList.add('md-diagram-xychart--vertical')
  }
  if (!isXychartHorizontal(source)) {
    return
  }
  const categoryCount = getXychartCategoryCount(source)
  if (categoryCount >= XYCHART_HORIZONTAL_MIN_CATEGORIES) {
    const minBodyHeight = Math.min(
      categoryCount * XYCHART_HORIZONTAL_ROW_MIN_HEIGHT +
      MARKDOWN_DIAGRAM_BODY_PADDING_VERTICAL,
      getMarkdownDiagramMaxHeight()
    )
    body.style.minHeight = `${minBodyHeight}px`
  }
}

const abortBlockRender = (block: Element) => {
  const controller = blockAbortControllers.get(block)
  if (controller) {
    controller.abort()
    blockAbortControllers.delete(block)
  }
}

const beginBlockRender = (block: Element): AbortSignal => {
  abortBlockRender(block)
  const controller = new AbortController()
  blockAbortControllers.set(block, controller)
  return controller.signal
}

const isRenderAborted = (error: unknown, signal: AbortSignal) =>
  signal.aborted ||
  (error instanceof DiagramRenderWorkerError &&
    error.message === 'Diagram render aborted')

const assertBlockConnected = (block: Element) => {
  if (!block.isConnected) {
    throw new DiagramRenderWorkerError('Diagram block detached')
  }
}

const isRetryableRenderError = (error: unknown, signal: AbortSignal) => {
  if (isRenderAborted(error, signal)) {
    return true
  }
  if (error instanceof DiagramRenderWorkerError) {
    return (
      error.message === 'Diagram block detached' ||
      error.message === 'Diagram worker render timeout'
    )
  }
  return false
}

const scheduleDiagramBlockRetry = (root?: Element | null) => {
  if (root) {
    diagramBlockRetryRoot = root
  }
  if (diagramBlockRetryTimer || typeof window === 'undefined') {
    return
  }
  diagramBlockRetryTimer = window.setTimeout(() => {
    diagramBlockRetryTimer = 0
    const scope = diagramBlockRetryRoot
    diagramBlockRetryRoot = null
    if (scope?.isConnected) {
      void renderMarkdownBlocks(scope)
    }
  }, DIAGRAM_BLOCK_RETRY_DEBOUNCE_MS)
}

const setBlockError = (block: Element, error: unknown) => {
  const body = block.querySelector<HTMLElement>('.md-diagram-body')
  const message =
    error instanceof Error ? error.message : String(error || 'Unknown error')
  block.classList.add('md-diagram-error')
  if (body) {
    clearDiagramBodyPending(body)
    const type = block.getAttribute(MARKDOWN_RENDER_ATTR)
    const rawSource = getSourceFromBlock(block).trim()
    const diagnosticParts = [
      formatDiagnosticSection(
        mt('markdownRenderer.diagramError.error', 'Error'),
        message
      )
    ]
    // Mermaid：附带规范化前后源码，便于对照 LLM 产出与修复结果
    if (type === 'mermaid' && rawSource) {
      const normalizedSource = normalizeMermaidSource(rawSource)
      diagnosticParts.push(
        formatDiagnosticSection(
          mt('markdownRenderer.diagramError.rawSource', 'Raw source'),
          rawSource
        )
      )
      if (normalizedSource !== rawSource) {
        diagnosticParts.push(
          formatDiagnosticSection(
            mt('markdownRenderer.diagramError.normalizedSource', 'Normalized source'),
            normalizedSource
          )
        )
      }
    }
    body.innerHTML = [
      '<div class="md-diagram-error-header">',
      `<div class="md-diagram-error-title"><strong>${escapeHtml(
        mt('markdownRenderer.diagramError.title', 'Diagram render failed')
      )}</strong></div>`,
      renderDiagnosticCopyButton(diagnosticParts.join('\n\n')),
      '</div>',
      renderDiagnosticDetails(diagnosticParts.join('\n\n'))
    ].join('')
  }
  block.setAttribute(MARKDOWN_RENDERED_ATTR, 'true')
  block.setAttribute(MARKDOWN_REVISION_ATTR, MARKDOWN_RENDERER_REVISION)
}

const mountDiagramMarkup = (body: HTMLElement, markup: string) => {
  const trimmed = markup.trim()
  if (trimmed.startsWith('<svg')) {
    const template = document.createElement('template')
    template.innerHTML = trimmed
    const svg = template.content.firstElementChild
    if (svg) {
      body.replaceChildren(svg)
      return
    }
  }
  body.innerHTML = markup
}

const finishMermaidDiagramLayout = (
  block: Element,
  body: HTMLElement,
  rawSource: string
) => {
  const source = normalizeMermaidSource(rawSource)
  applyXychartDiagramPresentation(block, body, source)
  const renderedSvg = body.querySelector('svg')
  if (renderedSvg instanceof SVGElement && isXychartSource(source)) {
    if (!isXychartHorizontal(source)) {
      fitDiagramSvgInBody(body)
      clearDiagramBodyPending(body)
      scheduleVerticalXychartLabelLayout(body, renderedSvg)
    } else {
      scheduleFitDiagramSvg(body)
    }
  } else {
    scheduleFitDiagramSvg(body)
  }
}

const tryMountDiagramFromCache = (
  block: Element,
  options?: RenderMarkdownBlocksOptions
): boolean => {
  const scope = options?.diagramCacheScope
  const type = block.getAttribute(MARKDOWN_RENDER_ATTR)
  if (
    !scope ||
    !type ||
    type === 'html' ||
    (type !== 'mermaid' && type !== 'plantuml' && type !== 'vegalite')
  ) {
    return false
  }
  const source = getSourceFromBlock(block)
  if (!source.trim()) {
    return false
  }
  const cached = getDiagramMarkupCache(scope, type, source)
  if (!cached) {
    return false
  }
  const body = block.querySelector<HTMLElement>('.md-diagram-body')
  if (!body) {
    return false
  }
  mountDiagramMarkup(body, cached)
  if (type === 'mermaid') {
    finishMermaidDiagramLayout(block, body, source)
  } else {
    scheduleFitDiagramSvg(body)
  }
  return true
}

const storeDiagramMarkupCache = (
  block: Element,
  options?: RenderMarkdownBlocksOptions
) => {
  const scope = options?.diagramCacheScope
  const type = block.getAttribute(MARKDOWN_RENDER_ATTR)
  if (
    !scope ||
    !type ||
    type === 'html' ||
    (type !== 'mermaid' && type !== 'plantuml' && type !== 'vegalite')
  ) {
    return
  }
  const source = getSourceFromBlock(block)
  if (!source.trim()) {
    return
  }
  const body = block.querySelector<HTMLElement>('.md-diagram-body')
  if (!body) {
    return
  }
  const svg = body.querySelector('svg')
  const markup = svg instanceof SVGElement ? svg.outerHTML : body.innerHTML
  if (!markup.trim()) {
    return
  }
  setDiagramMarkupCache(scope, type, source, markup)
}

const renderMermaidBlock = async (block: Element, signal: AbortSignal) => {
  const rawSource = getSourceFromBlock(block)
  const body = block.querySelector<HTMLElement>('.md-diagram-body')
  if (!rawSource.trim() || !body) {
    return
  }

  const source = normalizeMermaidSource(rawSource)
  applyXychartDiagramPresentation(block, body, source)
  assertBlockConnected(block)
  const { renderDiagramInWorker } = await getDiagramRuntime()
  const svg = await renderDiagramInWorker('mermaid', source, signal)
  assertBlockConnected(block)
  body.innerHTML = svg
  const renderedSvg = body.querySelector('svg')
  if (renderedSvg instanceof SVGElement && isXychartSource(source)) {
    applyXychartBarColors(renderedSvg)
    if (!isXychartHorizontal(source)) {
      wrapXychartVerticalCategoryLabels(renderedSvg)
    }
  }
  finishMermaidDiagramLayout(block, body, rawSource)
}

const renderPlantUmlBlock = async (block: Element, signal: AbortSignal) => {
  const source = getSourceFromBlock(block)
  const body = block.querySelector<HTMLElement>('.md-diagram-body')
  if (!source.trim() || !body) {
    return
  }

  assertBlockConnected(block)
  const { renderDiagramInWorker } = await getDiagramRuntime()
  const markup = await renderDiagramInWorker('plantuml', source, signal)
  assertBlockConnected(block)
  body.innerHTML = markup
  scheduleFitDiagramSvg(body)
}

/** 渲染 Vega-Lite 代码块为 SVG，并接入图表缩放逻辑 */
const renderVegaLiteBlock = async (block: Element, signal: AbortSignal) => {
  const rawSource = getSourceFromBlock(block)
  const body = block.querySelector<HTMLElement>('.md-diagram-body')
  if (!rawSource.trim() || !body) {
    return
  }

  assertBlockConnected(block)
  const { renderDiagramInWorker } = await getDiagramRuntime()
  const markup = await renderDiagramInWorker('vegalite', rawSource, signal)
  assertBlockConnected(block)
  mountDiagramMarkup(body, markup)
  scheduleFitDiagramSvg(body)
}

const buildHtmlPreviewDocument = (html: string) => `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<base target="_blank">
	<style>
		html, body {
			margin: 0;
			padding: 0;
			min-height: 0;
			height: auto;
			box-sizing: border-box;
			overflow: visible;
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			color: #1f2933;
			background: #fff;
		}
		body {
			display: block;
		}
		body > :first-child {
			margin-top: 0 !important;
			padding-top: 0 !important;
			min-height: 0 !important;
			align-items: flex-start !important;
			justify-content: flex-start !important;
		}
		* {
			box-sizing: border-box;
		}
		img, svg, canvas, video {
			max-width: 100%;
			height: auto;
		}
		table {
			max-width: 100%;
		}
	</style>
</head>
<body>${html}</body>
</html>`

/**
 * 测量 HTML 预览文档真实内容占位。
 * 结合 bbox 与 scrollHeight（iframe 仅设宽度、不设虚高时 scrollHeight 可信），并加底部余量防裁切。
 */
const measureHtmlPreviewContentSize = (doc: Document, layoutWidth: number) => {
  const body = doc.body
  const html = doc.documentElement
  if (!body) {
    return { width: layoutWidth, height: 1 }
  }

  const bodyRect = body.getBoundingClientRect()
  let maxBottom = 0
  let maxRight = 0

  const consider = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 && rect.height < 1) {
      return
    }
    maxBottom = Math.max(maxBottom, rect.bottom - bodyRect.top)
    maxRight = Math.max(maxRight, rect.right - bodyRect.left)
  }

  for (const child of body.children) {
    if (child instanceof HTMLElement) {
      consider(child)
    }
  }
  let nodeCount = 0
  body.querySelectorAll<HTMLElement>('*').forEach((el) => {
    if (nodeCount >= HTML_PREVIEW_MAX_MEASURE_NODES) {
      return
    }
    nodeCount++
    consider(el)
  })

  const bboxHeight = Math.max(1, Math.ceil(maxBottom))
  const bboxWidth = Math.max(1, Math.ceil(maxRight))
  const scrollHeight = Math.ceil(
    Math.max(body.scrollHeight, html.scrollHeight, html.offsetHeight)
  )
  const scrollWidth = Math.ceil(
    Math.max(body.scrollWidth, html.scrollWidth, layoutWidth)
  )

  // scrollHeight 异常偏大（历史 5000px 虚高）时忽略，仅信任 bbox
  const height =
    scrollHeight > bboxHeight && scrollHeight <= bboxHeight * 2.5
      ? scrollHeight
      : bboxHeight
  const width =
    scrollWidth > bboxWidth && scrollWidth <= layoutWidth * 2.5
      ? scrollWidth
      : Math.max(bboxWidth, layoutWidth)

  return {
    width: Math.max(layoutWidth, width),
    height: height + HTML_PREVIEW_THUMB_MEASURE_PADDING
  }
}

const resolveHtmlPreviewContainerWidth = (wrap: HTMLElement) => {
  const fromWrap = wrap.clientWidth
  if (fromWrap > 0) {
    return fromWrap
  }
  const fromParent = wrap.parentElement?.clientWidth ?? 0
  if (fromParent > 0) {
    return fromParent
  }
  const fromMessage = wrap.closest('.message-md, .message-content') as HTMLElement | null
  if (fromMessage && fromMessage.clientWidth > 0) {
    return fromMessage.clientWidth
  }
  return 360
}

const ensureHtmlPreviewScaler = (
  wrap: HTMLElement,
  iframe: HTMLIFrameElement
): HTMLElement => {
  let scaler = wrap.querySelector<HTMLElement>(':scope > .md-html-preview-scaler')
  if (!scaler) {
    scaler = document.createElement('div')
    scaler.className = 'md-html-preview-scaler'
    wrap.insertBefore(scaler, iframe)
    scaler.appendChild(iframe)
  }
  return scaler
}

const htmlPreviewFitObservers = new WeakMap<HTMLElement, ResizeObserver>()

/**
 * 将 HTML 预览 iframe 缩略为无滚动的等比缩略图（点击后在全屏层交互）。
 */
const applyHtmlPreviewThumbScale = (
  iframe: HTMLIFrameElement,
  scale: number,
  contentWidth: number,
  contentHeight: number,
  scaledW: number,
  scaledH: number
) => {
  const scaler = ensureHtmlPreviewScaler(
    iframe.closest('.md-html-preview-wrap') as HTMLElement,
    iframe
  )

  iframe.style.width = `${contentWidth}px`
  iframe.style.height = `${contentHeight}px`
  iframe.style.display = 'block'
  iframe.style.margin = '0'
  iframe.style.overflow = 'visible'
  iframe.style.pointerEvents = 'none'
  iframe.style.border = 'none'
  iframe.setAttribute('scrolling', 'no')

  const iframeStyle = iframe.style as CSSStyleDeclaration & { zoom?: string }
  if (scale !== 1 && 'zoom' in iframeStyle) {
    iframeStyle.zoom = String(scale)
    iframe.style.transform = 'none'
    iframe.style.transformOrigin = ''
  } else {
    iframeStyle.zoom = ''
    iframe.style.transform = scale !== 1 ? `scale(${scale})` : 'none'
    iframe.style.transformOrigin = '0 0'
  }

  const scalerPad = scale < 1 ? 2 : 4
  scaler.style.width = `${scaledW + scalerPad}px`
  scaler.style.height = `${scaledH + scalerPad}px`
  scaler.style.margin = '0 auto'
  scaler.style.flexShrink = '0'
  scaler.style.overflow = 'visible'
}

const resizeHtmlPreview = (iframe: HTMLIFrameElement): boolean => {
  try {
    const doc = iframe.contentDocument
    if (!doc?.body) {
      return false
    }
    const wrap = iframe.closest('.md-html-preview-wrap') as HTMLElement | null
    if (!wrap) {
      return false
    }

    const thumbMaxHeight = getMarkdownHtmlPreviewMaxHeight()
    const containerWidth = Math.max(resolveHtmlPreviewContainerWidth(wrap) - 2, 160)

    // 仅在目标宽度下排版；勿拉高 iframe，否则 scrollHeight 污染测量
    iframe.style.width = `${containerWidth}px`
    iframe.style.height = 'auto'
    iframe.style.minHeight = '0'
    iframe.style.transform = 'none'
    ;(iframe.style as CSSStyleDeclaration & { zoom?: string }).zoom = ''
    void doc.body.offsetHeight

    const { width: contentWidth, height: contentHeight } =
      measureHtmlPreviewContentSize(doc, containerWidth)

    // 优先撑满缩略图高度，必要时放大；宽度超出时再收紧
    const scaleH = thumbMaxHeight / contentHeight
    const scaleW = containerWidth / contentWidth
    const scale = Math.min(scaleH, scaleW)
    const scaledW = Math.max(1, Math.ceil(contentWidth * scale))
    const scaledH = Math.max(1, Math.ceil(contentHeight * scale))

    applyHtmlPreviewThumbScale(
      iframe,
      scale,
      contentWidth,
      contentHeight,
      scaledW,
      scaledH
    )

    wrap.style.width = '100%'
    wrap.style.height = `${thumbMaxHeight}px`
    wrap.style.minHeight = `${thumbMaxHeight}px`
    wrap.style.maxHeight = `${thumbMaxHeight}px`
    wrap.style.display = 'flex'
    wrap.style.alignItems = 'center'
    wrap.style.justifyContent = 'center'
    wrap.style.overflow = 'hidden'
    wrap.dataset.mdHtmlThumb = 'true'
    return true
  } catch {
    /* sandboxed previews may be unreadable in stricter browser modes */
    return false
  }
}

const bindHtmlPreviewContentResize = (
  iframe: HTMLIFrameElement,
  onResize: () => void
) => {
  const doc = iframe.contentDocument
  if (!doc) {
    return
  }
  doc.querySelectorAll('img').forEach((img) => {
    if (img.complete) {
      return
    }
    img.addEventListener('load', onResize, { once: true })
    img.addEventListener('error', onResize, { once: true })
  })
}

const scheduleHtmlPreviewFit = (iframe: HTMLIFrameElement) => {
  if (globalResizeInProgress) {
    deferredHtmlPreviewIframes.add(iframe)
    return
  }

  const existing = htmlPreviewFitTimers.get(iframe)
  if (existing) {
    clearTimeout(existing)
  }

  const timer = setTimeout(() => {
    htmlPreviewFitTimers.delete(iframe)
    const run = () => {
      resizeHtmlPreview(iframe)
    }
    run()
    requestAnimationFrame(() => {
      run()
      bindHtmlPreviewContentResize(iframe, run)
    })
  }, HTML_PREVIEW_FIT_DEBOUNCE_MS)
  htmlPreviewFitTimers.set(iframe, timer)
}

const resolveExpandedHtmlPreviewContainerWidth = (iframe: HTMLIFrameElement) => {
  const wrap = iframe.closest('.md-html-preview-wrap') as HTMLElement | null
  if (wrap) {
    return Math.max(resolveHtmlPreviewContainerWidth(wrap), 360)
  }
  const parent = iframe.parentElement
  if (!parent) {
    return 360
  }
  const styles = getComputedStyle(parent)
  const padX =
    (Number.parseFloat(styles.paddingLeft) || 0) +
    (Number.parseFloat(styles.paddingRight) || 0)
  return Math.max(parent.clientWidth - padX, 360)
}

/** 全屏 HTML 预览：自然尺寸、可滚动、可交互 */
export const resizeMarkdownHtmlPreviewExpanded = (
  iframe: HTMLIFrameElement
): boolean => {
  try {
    const doc = iframe.contentDocument
    if (!doc?.body) {
      return false
    }
    const containerWidth = resolveExpandedHtmlPreviewContainerWidth(iframe)
    const { width: contentWidth, height: contentHeight } =
      measureHtmlPreviewContentSize(doc, containerWidth)

    ;(iframe.style as CSSStyleDeclaration & { zoom?: string }).zoom = ''
    iframe.style.transform = ''
    iframe.style.transformOrigin = ''
    iframe.style.width = '100%'
    iframe.style.minWidth = `${contentWidth}px`
    iframe.style.height = `${contentHeight}px`
    iframe.style.display = 'block'
    iframe.style.margin = '0'
    iframe.style.overflow = 'visible'
    iframe.style.pointerEvents = 'auto'
    iframe.setAttribute('scrolling', 'auto')
    return true
  } catch {
    return false
  }
}

/** 监听 HTML 预览块宽度变化并重新适配高度 */
const observeHtmlPreviewResize = (
  block: HTMLElement,
  iframe: HTMLIFrameElement
) => {
  const existing = htmlPreviewFitObservers.get(block)
  if (existing) {
    existing.disconnect()
  }
  if (typeof ResizeObserver === 'undefined') {
    return
  }
  const wrap = block.querySelector('.md-html-preview-wrap')
  const observer = new ResizeObserver(() => scheduleHtmlPreviewFit(iframe))
  observer.observe(block)
  if (wrap instanceof HTMLElement) {
    observer.observe(wrap)
  }
  htmlPreviewFitObservers.set(block, observer)
}

const renderHtmlPreviewBlock = (block: Element) => {
  const source = getSourceFromBlock(block)
  const iframe = block.querySelector<HTMLIFrameElement>(
    'iframe.md-html-preview'
  )
  const wrap = block.querySelector<HTMLElement>('.md-html-preview-wrap')
  if (!iframe || !wrap) {
    return
  }

  const finishLoading = () => {
    resizeHtmlPreview(iframe)
    wrap.classList.remove('md-block-pending')
    scheduleHtmlPreviewFit(iframe)
    observeHtmlPreviewResize(block as HTMLElement, iframe)
  }

  iframe.onload = finishLoading
  iframe.srcdoc = buildHtmlPreviewDocument(source)
}

/** 图表块已按旧版逻辑渲染时，重置为占位以便用当前 revision 重绘。 */
const resetStaleDiagramBlock = (block: Element) => {
  abortBlockRender(block)
  block.removeAttribute(MARKDOWN_RENDERED_ATTR)
  block.classList.remove(
    'md-diagram-error',
    'md-diagram-xychart',
    'md-diagram-xychart--horizontal',
    'md-diagram-xychart--vertical'
  )
  const body = block.querySelector<HTMLElement>('.md-diagram-body')
  if (body) {
    disconnectDiagramFitObserver(body)
    body.classList.remove('md-diagram-body--wide')
    body.classList.add('md-block-pending')
    body.innerHTML = renderGeneratingHintHtml()
    body.style.cssText = ''
  }
  block.removeAttribute(MARKDOWN_REVISION_ATTR)
}

const getDiagramBodyForRefit = (block: Element): HTMLElement | undefined => {
  const type = block.getAttribute(MARKDOWN_RENDER_ATTR)
  if (type === 'html') {
    return undefined
  }
  const body = block.querySelector<HTMLElement>('.md-diagram-body')
  return body ?? undefined
}

/** 异步图表/HTML 块是否已具备渲染条件（围栏闭合 + 源码可解析） */
const isAsyncDiagramBlockReady = (
  block: Element,
  options?: RenderMarkdownBlocksOptions
): boolean => {
  if (block.getAttribute(MARKDOWN_FENCE_OPEN_ATTR) === 'true') {
    return false
  }
  if (options?.deferDiagrams && block.closest('[data-md-stream-tail]')) {
    return false
  }
  const type = block.getAttribute(MARKDOWN_RENDER_ATTR)
  const source = getSourceFromBlock(block)
  if (type === 'vegalite') {
    return tryParseVegaLiteSpec(source) !== null
  }
  if (type === 'mermaid') {
    return normalizeMermaidSource(source).trim().length > 0
  }
  if (type === 'plantuml' || type === 'html') {
    return source.trim().length > 0
  }
  return true
}

const renderBlock = async (
  block: Element,
  options?: RenderMarkdownBlocksOptions,
  renderGeneration = markdownRenderGeneration
): Promise<HTMLElement | undefined> => {
  if (!isMarkdownRenderGenerationCurrent(renderGeneration)) {
    return undefined
  }
  if (block.getAttribute(MARKDOWN_RENDERING_ATTR) === 'true') {
    return undefined
  }

  const revision = block.getAttribute(MARKDOWN_REVISION_ATTR)
  const alreadyRendered = block.getAttribute(MARKDOWN_RENDERED_ATTR) === 'true'
  if (alreadyRendered) {
    if (revision === MARKDOWN_RENDERER_REVISION) {
      return undefined
    }
    resetStaleDiagramBlock(block)
  }

  const type = block.getAttribute(MARKDOWN_RENDER_ATTR)
  const isAsyncBlock =
    type === 'mermaid' ||
    type === 'plantuml' ||
    type === 'vegalite' ||
    type === 'html'
  if (isAsyncBlock && !isAsyncDiagramBlockReady(block, options)) {
    return undefined
  }

  block.setAttribute(MARKDOWN_RENDERING_ATTR, 'true')
  const signal = beginBlockRender(block)
  try {
    if (type === 'html') {
      renderHtmlPreviewBlock(block)
    } else if (type === 'mermaid') {
      if (!tryMountDiagramFromCache(block, options)) {
        await renderMermaidBlock(block, signal)
      }
    } else if (type === 'plantuml') {
      if (!tryMountDiagramFromCache(block, options)) {
        await renderPlantUmlBlock(block, signal)
      }
    } else if (type === 'vegalite') {
      if (!tryMountDiagramFromCache(block, options)) {
        await renderVegaLiteBlock(block, signal)
      }
    }
    if (
      !block.isConnected ||
      !isMarkdownRenderGenerationCurrent(renderGeneration)
    ) {
      scheduleDiagramBlockRetry(block.closest('.message-md'))
      return undefined
    }
    block.setAttribute(MARKDOWN_RENDERED_ATTR, 'true')
    block.setAttribute(MARKDOWN_REVISION_ATTR, MARKDOWN_RENDERER_REVISION)
    blockAbortControllers.delete(block)
    storeDiagramMarkupCache(block, options)
    return getDiagramBodyForRefit(block)
  } catch (error) {
    if (isRetryableRenderError(error, signal)) {
      scheduleDiagramBlockRetry(block.closest('.message-md'))
      return undefined
    }
    setBlockError(block, error)
    return undefined
  } finally {
    block.removeAttribute(MARKDOWN_RENDERING_ATTR)
  }
}

const isImageOnlyParagraphElement = (p: HTMLParagraphElement): boolean => {
  const meaningful = [...p.childNodes].filter((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent ?? '').trim().length > 0
    }
    return node.nodeType === Node.ELEMENT_NODE
  })
  if (meaningful.length === 1) {
    const only = meaningful[0]
    if (only instanceof HTMLImageElement) {
      return true
    }
    if (only instanceof HTMLAnchorElement) {
      const imgs = only.querySelectorAll('img')
      return imgs.length === 1 && (only.textContent ?? '').trim().length === 0
    }
  }
  return false
}

const applyImageParagraphNormalization = (p: HTMLParagraphElement) => {
  p.classList.add(MD_P_IMAGE_CLASS)
  p.style.lineHeight = '0'
}

const clearImageParagraphNormalization = (p: HTMLParagraphElement) => {
  p.classList.remove(MD_P_IMAGE_CLASS)
  p.style.lineHeight = ''
}

const isImageLoadedSuccessfully = (img: HTMLImageElement) =>
  img.complete && img.naturalWidth > 0 && img.naturalHeight > 0

const bindImageLoadNormalization = (img: HTMLImageElement) => {
  const normalizeOnSuccess = () => {
    if (!isImageLoadedSuccessfully(img)) {
      return
    }
    const p = img.closest('p')
    if (p instanceof HTMLParagraphElement && isImageOnlyParagraphElement(p)) {
      applyImageParagraphNormalization(p)
    }
  }

  const normalizeOnError = () => {
    const p = img.closest('p')
    if (p instanceof HTMLParagraphElement) {
      clearImageParagraphNormalization(p)
    }
  }

  if (isImageLoadedSuccessfully(img)) {
    normalizeOnSuccess()
  } else if (img.complete) {
    normalizeOnError()
  } else {
    img.addEventListener('load', normalizeOnSuccess, { once: true })
    img.addEventListener('error', normalizeOnError, { once: true })
  }
}

const collectMarkdownImages = (root: ParentNode | Element): HTMLImageElement[] => {
  const scoped = Array.from(
    root.querySelectorAll<HTMLImageElement>('.message-md img')
  )
  if (scoped.length > 0) {
    return scoped
  }
  // 流式尾段容器在 .message-md 内，但不是其祖先，无法用 `.message-md img` 命中
  if (root instanceof Element && root.closest('.message-md')) {
    return Array.from(root.querySelectorAll<HTMLImageElement>('img'))
  }
  return scoped
}

/**
 * 图片加载成功后压缩单图段落的 line-height；加载失败时保持正常行高，避免 alt 文本叠在一起。
 */
export const normalizeMarkdownImageParagraphs = (root: ParentNode | Element) => {
  collectMarkdownImages(root).forEach((img) => {
    const src = img.getAttribute('src')
    if (src) {
      const normalized = appendAuthTokenToUrl(normalizeRepoFileUrl(src))
      if (normalized !== src) {
        img.src = normalized
      }
    }
    bindImageLoadNormalization(img)
  })
}

/** 在 root 内渲染 mermaid/plantuml/vegalite/html 等异步 Markdown 块 */
const executeRenderMarkdownBlocks = async (
  root: ParentNode | Element,
  options?: RenderMarkdownBlocksOptions
) => {
  const renderGeneration = markdownRenderGeneration
  const blocks = collectCandidateMarkdownBlocks(root).filter((block) =>
    isBlockPendingRender(block, options)
  )
  if (!isMarkdownRenderGenerationCurrent(renderGeneration)) {
    return
  }
  let bodiesToRefit: HTMLElement[] = []

  if (blocks.length > 0) {
    const lazy = options?.lazy !== false
    if (lazy) {
      bodiesToRefit = await renderWithViewportScheduling(
        blocks,
        options ?? {},
        renderGeneration
      )
    } else {
      const concurrency =
        options?.concurrency ?? DEFAULT_DIAGRAM_RENDER_CONCURRENCY
      await mapWithConcurrency(blocks, concurrency, async (block) => {
        if (!isMarkdownRenderGenerationCurrent(renderGeneration)) {
          return
        }
        if (!isBlockPendingRender(block, options)) {
          return
        }
        const body = await renderBlock(block, options, renderGeneration)
        if (body) {
          bodiesToRefit.push(body)
        }
      })
    }
  }

  if (!isMarkdownRenderGenerationCurrent(renderGeneration)) {
    return
  }

  refitDiagramBodies(bodiesToRefit)
  normalizeMarkdownImageParagraphs(root)
}

export const renderMarkdownBlocks = (
  root: ParentNode | Element,
  options?: RenderMarkdownBlocksOptions
): Promise<void> => {
  const task = renderMarkdownBlocksChain.then(() =>
    executeRenderMarkdownBlocks(root, options)
  )
  renderMarkdownBlocksChain = task.catch(() => {})
  return task
}

/** 对 root 内已渲染图表按当前宽度重新适配外框高度 */
export const refitDiagramBlocksInRoot = (root: ParentNode | Element) => {
  root.querySelectorAll<HTMLElement>('.md-diagram-body').forEach((body) => {
    if (!isDiagramBodyReflowEligible(body)) {
      return
    }
    scheduleFitDiagramSvgReflow(body)
  })
}

/** keep-alive 切走：断开 root 下图表 ResizeObserver 并清 pending refit */
export const pauseDiagramReflowInRoot = (root: Element | null | undefined) => {
  if (!root) {
    return
  }
  root.querySelectorAll<HTMLElement>('.md-diagram-body').forEach((body) => {
    disconnectDiagramFitObserver(body)
    const throttleTimer = diagramFitThrottleTimers.get(body)
    if (throttleTimer) {
      clearTimeout(throttleTimer)
      diagramFitThrottleTimers.delete(body)
    }
    pendingRefitBodies.delete(body)
    diagramFitInProgress.delete(body)
  })
}

/** keep-alive 切走或会话隐藏时：清空排队中的 Markdown/图表任务，避免在不可见 DOM 上继续渲染 */
export const cancelPendingMarkdownRenderWork = (scope?: Element | null) => {
  markdownRenderGeneration++
  renderMarkdownBlocksChain = Promise.resolve()
  void getDiagramRuntime().then((runtime) =>
    runtime.cancelDiagramRenderWorkerTasks()
  )
  if (batchRefitRafId) {
    cancelAnimationFrame(batchRefitRafId)
    batchRefitRafId = 0
  }
  pendingRefitBodies.clear()
  if (streamTailUpdateRafId) {
    cancelAnimationFrame(streamTailUpdateRafId)
    streamTailUpdateRafId = 0
  }
  if (streamTailThrottleTimer) {
    clearTimeout(streamTailThrottleTimer)
    streamTailThrottleTimer = 0
  }
  if (diagramBlockRetryTimer) {
    clearTimeout(diagramBlockRetryTimer)
    diagramBlockRetryTimer = 0
  }
  diagramBlockRetryRoot = null
  pendingStreamTailUpdate = null
  if (scope) {
    scope.querySelectorAll<Element>(`[${MARKDOWN_RENDER_ATTR}]`).forEach((block) => {
      abortBlockRender(block)
      block.removeAttribute(MARKDOWN_RENDERING_ATTR)
    })
  }
}

export const resetMarkdownRendererForTest = () => {
  void getDiagramRuntime().then((runtime) =>
    runtime.resetDiagramMarkdownRuntimeForTest()
  )
  invalidateDiagramMaxHeightCache()
  clearMarkdownHtmlCache()
  diagramMarkupCache.clear()
  diagramMarkupCacheSessionCounts.clear()
  pendingRefitBodies.clear()
  if (batchRefitRafId) {
    cancelAnimationFrame(batchRefitRafId)
    batchRefitRafId = 0
  }
  renderMarkdownBlocksChain = Promise.resolve()
  markdownRenderGeneration = 0
  if (streamTailUpdateRafId) {
    cancelAnimationFrame(streamTailUpdateRafId)
    streamTailUpdateRafId = 0
  }
  if (streamTailThrottleTimer) {
    clearTimeout(streamTailThrottleTimer)
    streamTailThrottleTimer = 0
  }
  if (diagramWindowResizeDebounceTimer) {
    clearTimeout(diagramWindowResizeDebounceTimer)
    diagramWindowResizeDebounceTimer = 0
  }
  if (diagramBlockRetryTimer) {
    clearTimeout(diagramBlockRetryTimer)
    diagramBlockRetryTimer = 0
  }
  diagramBlockRetryRoot = null
  deferredHtmlPreviewIframes.clear()
  globalResizeInProgress = false
  streamTailLastRunAt = 0
  pendingStreamTailUpdate = null
}

/** 单测用：xychart 横向修正与类目计数 */
export const markdownRendererXychartInternals = {
  getXychartDeclarationLine,
  countXychartCategories,
  countXychartBarValues,
  getXychartCategoryCount,
  normalizeXychartOrientation,
  isXychartHorizontal
}
