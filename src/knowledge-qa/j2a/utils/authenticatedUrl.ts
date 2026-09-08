import {
  knowledgeQaConfig,
  resolveConfiguredBackendOrigin,
  resolveRequestBaseUrl,
  shouldUseDevProxy
} from '../../config'

const PROTECTED_PATH_MARKERS = [
  '/file/repo/',
  '/file/static/',
  '/chat/files/content',
  '/files/content',
  '/files/upload/content',
  '/knowledge/json-template'
]

const isOssPresignedUrl = (url: string): boolean =>
  url.includes('X-Amz-Algorithm=') || url.includes('X-Amz-Signature=')

const resolveUrlPath = (url: string): string | null => {
  try {
    return new URL(url, window.location.origin).pathname
  } catch {
    return null
  }
}

/** 相对路径或后端同源路径是否需要鉴权 */
export function needsAuthInUrl(url: string): boolean {
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) {
    return false
  }
  if (isOssPresignedUrl(url)) {
    return false
  }
  const path = resolveUrlPath(url)
  if (!path) {
    return false
  }
  if (!path.startsWith('/v1/') && !url.startsWith('/')) {
    return false
  }
  return PROTECTED_PATH_MARKERS.some((marker) => path.includes(marker))
}

/**
 * 开发代理模式下，把直连后端的绝对 URL 改写为同源相对路径。
 */
function toSameOriginIfProxy(url: string): string {
  if (!shouldUseDevProxy()) {
    return url
  }
  try {
    const parsed = new URL(url, window.location.origin)
    const backendOrigin = resolveConfiguredBackendOrigin()
    if (parsed.origin === backendOrigin || parsed.origin === window.location.origin) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`
    }
  } catch {
    /* ignore */
  }
  return url
}

/**
 * 将相对 /v1 链接改写到请求基址，并附带 authorization query（避免 CORS 预检）。
 */
export function appendAuthTokenToUrl(url: string): string {
  if (!url) {
    return url
  }
  const base = resolveRequestBaseUrl()
  let absolute = url
  try {
    if (url.startsWith('/')) {
      absolute = base ? `${base}${url}` : url
    } else {
      const parsed = new URL(url, base || window.location.origin)
      if (
        parsed.pathname.startsWith('/v1/') ||
        PROTECTED_PATH_MARKERS.some((m) => parsed.pathname.includes(m))
      ) {
        absolute = base
          ? `${base}${parsed.pathname}${parsed.search}${parsed.hash}`
          : `${parsed.pathname}${parsed.search}${parsed.hash}`
      } else {
        absolute = parsed.toString()
      }
    }
  } catch {
    if (url.startsWith('/')) {
      absolute = base ? `${base}${url}` : url
    }
  }

  absolute = toSameOriginIfProxy(absolute)

  if (!needsAuthInUrl(absolute) && !absolute.includes('/file/')) {
    return absolute
  }

  try {
    const parsed = new URL(absolute, window.location.origin)
    if (!parsed.searchParams.has('authorization')) {
      parsed.searchParams.set('authorization', knowledgeQaConfig.apiKey)
    }
    // 同源相对路径时返回 path+query，避免强制绝对跨域
    if (!base || shouldUseDevProxy()) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`
    }
    return parsed.toString()
  } catch {
    return absolute
  }
}

export function getBearerAuthHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${knowledgeQaConfig.apiKey}`
  }
}

/**
 * 拉取受保护资源：只走 query authorization，不带 Authorization 头，
 * 避免跨域 OPTIONS 预检；开发态再配合 Vite 同源代理彻底绕过 CORS。
 */
export function authenticatedFetch(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const absolute = appendAuthTokenToUrl(url)
  const headers = new Headers(init.headers)
  // 故意不附加 Authorization / 自定义头，保持 simple request
  headers.delete('Authorization')
  return fetch(absolute, { ...init, headers, credentials: 'omit' })
}
