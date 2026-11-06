import {
  knowledgeQaConfig,
  KNOWLEDGE_QA_ASSISTANT_ID,
  resolveConfiguredBackendOrigin,
  resolveRequestBaseUrl,
  shouldUseDevProxy
} from './config'
import type { KbSrcFile } from './types'

const PROGRAM_TAG = 'j2agent'
const REPO_FILE_MARKER = '/file/repo/'

/** 实际请求根地址（开发代理时为空） */
export function getBackendBaseUrl(): string {
  return resolveRequestBaseUrl()
}

/** 将 http(s) 根地址转为 ws(s)；空基址则用当前页 Origin */
function toWsOrigin(httpBase: string): string {
  if (!httpBase) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}`
  }
  if (httpBase.startsWith('https://')) {
    return `wss://${httpBase.slice('https://'.length)}`
  }
  if (httpBase.startsWith('http://')) {
    return `ws://${httpBase.slice('http://'.length)}`
  }
  return httpBase.replace(/^http/, 'ws')
}

/** REST 公共鉴权头（仅同源/代理场景使用，减少跨域预检） */
export function getAuthHeaders(locale: 'zh' | 'en'): Record<string, string> {
  const localeHeader = locale === 'en' ? 'en_US' : 'zh_CN'
  const headers: Record<string, string> = {
    'X-Locale': localeHeader,
    'Accept-Language': localeHeader.replace('_', '-')
  }
  // 开发代理同源时可带 Bearer；跨域直连改用 query，避免预检
  if (shouldUseDevProxy() || !getBackendBaseUrl()) {
    headers.Authorization = `Bearer ${knowledgeQaConfig.apiKey}`
  }
  return headers
}

/**
 * 向后端申请新的 contextId（必须走服务端签发，禁止本地 UUID，否则会触发 does not own）。
 */
export async function fetchContextId(locale: 'zh' | 'en'): Promise<string> {
  const base = getBackendBaseUrl()
  const path = `/v1/rest/${PROGRAM_TAG}/context/id`
  const useProxy = shouldUseDevProxy() || !base

  let finalUrl: string
  let headers: HeadersInit
  if (useProxy) {
    finalUrl = `${base}${path}`
    headers = getAuthHeaders(locale)
  } else {
    // 跨域直连：仅用 query 鉴权，避免自定义头触发预检
    finalUrl = `${base}${path}?authorization=${encodeURIComponent(knowledgeQaConfig.apiKey)}`
    headers = {}
  }

  const response = await fetch(finalUrl, {
    method: 'GET',
    headers,
    cache: 'no-store',
    credentials: 'omit'
  })
  if (!response.ok) {
    throw new Error(`context/id HTTP ${response.status}`)
  }
  const body = (await response.json()) as {
    contextId?: string
    data?: { contextId?: string }
  }
  const contextId = body.contextId?.trim() || body.data?.contextId?.trim()
  if (!contextId) {
    throw new Error('context/id response missing contextId')
  }
  return contextId
}

/** 构造知识库问答 WebSocket URL（对齐 j2a：context-id / agent-id 显式 encode） */
export function buildChatWebSocketUrl(
  contextId: string,
  locale: 'zh' | 'en',
  options?: { resume?: boolean }
): string {
  const wsOrigin = toWsOrigin(getBackendBaseUrl())
  const localeParam = locale === 'en' ? 'en_US' : 'zh_CN'
  const resumeQuery = options?.resume ? '&resume=true' : ''
  const authQuery = `&authorization=${encodeURIComponent(knowledgeQaConfig.apiKey)}`
  return (
    `${wsOrigin}/ws/rest/${PROGRAM_TAG}/chat` +
    `?context-id=${encodeURIComponent(contextId)}` +
    `&agent-id=${encodeURIComponent(KNOWLEDGE_QA_ASSISTANT_ID)}` +
    `&locale=${encodeURIComponent(localeParam)}` +
    resumeQuery +
    authQuery
  )
}

/** 来源展示文案：去掉首段目录前缀 */
export function formatSrcFileLabel(file: KbSrcFile): string {
  if (file.relativePath) {
    const slash = file.relativePath.indexOf('/')
    return slash >= 0 ? file.relativePath.slice(slash + 1) : file.relativePath
  }
  return file.fullFileName
}

/**
 * 将知识库文件链接改写到请求基址（开发态改同源），并附带 authorization。
 */
export function resolveSrcFileUrl(url: string): string {
  if (!url) {
    return url
  }
  if (url.startsWith('blob:') || url.startsWith('data:')) {
    return url
  }

  const base = getBackendBaseUrl()
  let absolute = url
  try {
    if (url.startsWith('/')) {
      absolute = base ? `${base}${url}` : url
    } else {
      const parsed = new URL(url, base || window.location.origin)
      if (
        parsed.pathname.includes(REPO_FILE_MARKER) ||
        parsed.pathname.includes('/v1/rest/')
      ) {
        absolute = base
          ? `${base}${parsed.pathname}${parsed.search}${parsed.hash}`
          : `${parsed.pathname}${parsed.search}${parsed.hash}`
      }
    }
  } catch {
    if (url.startsWith('/')) {
      absolute = base ? `${base}${url}` : url
    }
  }

  // 开发代理：绝对后端 URL → 同源相对路径
  if (shouldUseDevProxy()) {
    try {
      const parsed = new URL(absolute, window.location.origin)
      const backendOrigin = resolveConfiguredBackendOrigin()
      if (
        parsed.origin === backendOrigin ||
        parsed.origin === window.location.origin
      ) {
        absolute = `${parsed.pathname}${parsed.search}${parsed.hash}`
      }
    } catch {
      /* ignore */
    }
  }

  if (!absolute.includes(REPO_FILE_MARKER) && !absolute.includes('/file/')) {
    return absolute
  }
  try {
    const parsed = new URL(absolute, window.location.origin)
    if (!parsed.searchParams.has('authorization')) {
      parsed.searchParams.set('authorization', knowledgeQaConfig.apiKey)
    }
    if (!base || shouldUseDevProxy()) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`
    }
    return parsed.toString()
  } catch {
    return absolute
  }
}

/** 规范化并去重合并来源文件列表 */
export function mergeSrcFiles(
  existing: KbSrcFile[] | undefined,
  incoming: KbSrcFile[]
): KbSrcFile[] {
  const map = new Map<string, KbSrcFile>()
  const keyOf = (file: KbSrcFile) =>
    file.relativePath?.trim() || file.url?.trim() || file.fullFileName?.trim() || ''

  for (const file of existing ?? []) {
    const key = keyOf(file)
    if (key) {
      map.set(key, { ...file, url: resolveSrcFileUrl(file.url) })
    }
  }
  for (const file of incoming) {
    const key = keyOf(file)
    if (key) {
      map.set(key, { ...file, url: resolveSrcFileUrl(file.url) })
    }
  }
  return [...map.values()]
}

/** 热门问题条目 */
export type KbHotQuestion = {
  question: string
}

/**
 * 获取智能体热门问题模板（对齐 j2a getQaTemplate）。
 */
export async function fetchQaTemplate(
  locale: 'zh' | 'en',
  limit = 4
): Promise<KbHotQuestion[]> {
  const base = getBackendBaseUrl()
  const path = `/v1/rest/${PROGRAM_TAG}/qa-template`
  const useProxy = shouldUseDevProxy() || !base
  const params = new URLSearchParams({
    'agent-id': KNOWLEDGE_QA_ASSISTANT_ID,
    limit: String(limit)
  })

  let finalUrl: string
  let headers: HeadersInit
  if (useProxy) {
    finalUrl = `${base}${path}?${params}`
    headers = getAuthHeaders(locale)
  } else {
    params.set('authorization', knowledgeQaConfig.apiKey)
    finalUrl = `${base}${path}?${params}`
    headers = {}
  }

  const response = await fetch(finalUrl, {
    method: 'GET',
    headers,
    cache: 'no-store',
    credentials: 'omit'
  })
  if (!response.ok) {
    throw new Error(`qa-template HTTP ${response.status}`)
  }
  const body = (await response.json()) as
    | { data?: KbHotQuestion[] }
    | { data?: { data?: KbHotQuestion[] } }
  const list = Array.isArray(body.data)
    ? body.data
    : body.data?.data
  return (list ?? []).filter((item) => item.question?.trim())
}

/**
 * 主动停止后台对话任务（对齐 j2a stopChatTurn）。
 */
export async function stopChatTurn(
  contextId: string,
  locale: 'zh' | 'en'
): Promise<void> {
  const base = getBackendBaseUrl()
  const path = `/v1/rest/${PROGRAM_TAG}/chat/stop`
  const params = new URLSearchParams({
    'context-id': contextId,
    'agent-id': KNOWLEDGE_QA_ASSISTANT_ID
  })
  const useProxy = shouldUseDevProxy() || !base

  let finalUrl: string
  let headers: HeadersInit
  if (useProxy) {
    finalUrl = `${base}${path}?${params}`
    headers = getAuthHeaders(locale)
  } else {
    params.set('authorization', knowledgeQaConfig.apiKey)
    finalUrl = `${base}${path}?${params}`
    headers = { 'Content-Type': 'application/json' }
  }

  await fetch(finalUrl, {
    method: 'POST',
    headers,
    credentials: 'omit'
  }).catch((error) => {
    console.warn('[knowledge-qa] stopChatTurn failed', error)
  })
}
