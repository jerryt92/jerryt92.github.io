import { appendAuthTokenToUrl } from './authenticatedUrl'
import { globalUrlPrefix, programTag } from '../shims/oem'

const REPO_FILE_PATH_MARKER = '/file/repo/'
const MD_IMAGE_PATTERN = /!\[([^\]]*)]\(([^)]+)\)/g
const MD_LINK_PATTERN = /(?<!!)\[([^\]]*)]\(([^)]+)\)/g

const encodeRepoPathSegments = (relativePath: string) =>
  relativePath
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')

/**
 * 将历史整段 %2F 编码的知识库直链改为按路径段编码，避免 Tomcat/网关返回 400。
 */
export const normalizeRepoFileUrl = (url: string): string => {
  if (!url?.includes('%2F') || !url.includes(REPO_FILE_PATH_MARKER)) {
    return appendAuthTokenToUrl(url)
  }
  const markerIdx = url.indexOf(REPO_FILE_PATH_MARKER)
  const prefix = url.slice(0, markerIdx + REPO_FILE_PATH_MARKER.length)
  const remainder = url.slice(markerIdx + REPO_FILE_PATH_MARKER.length)
  const suffixMatch = remainder.match(/[?#].*/)
  const suffix = suffixMatch?.[0] ?? ''
  const encodedTail = suffix ? remainder.slice(0, -suffix.length) : remainder
  try {
    const relativePath = decodeURIComponent(encodedTail)
    if (!relativePath) {
      return appendAuthTokenToUrl(url)
    }
    return appendAuthTokenToUrl(prefix + encodeRepoPathSegments(relativePath) + suffix)
  } catch {
    return appendAuthTokenToUrl(url)
  }
}

/** 规范化 Markdown 正文中嵌入的知识库图片/链接 URL。 */
export const normalizeMarkdownRepoFileUrls = (markdown: string): string => {
  if (!markdown?.includes('%2F') || !markdown.includes(REPO_FILE_PATH_MARKER)) {
    return markdown
  }
  return markdown.replace(
    /(?:https?:\/\/[^\s"')]+|\/v1\/rest\/[^\s"')]+)\/file\/repo\/[^\s"')]+/gi,
    (url) => normalizeRepoFileUrl(url)
  )
}

/** 将知识库相对路径编码为 /file/repo/** 直链。 */
export const buildRepoFileUrl = (relativePath: string): string => {
  const base = `/v1${globalUrlPrefix}rest/${programTag}/file/repo/`
  if (!relativePath?.trim()) {
    return appendAuthTokenToUrl(base)
  }
  return appendAuthTokenToUrl(base + encodeRepoPathSegments(relativePath))
}

const splitUrlHash = (href: string): { path: string; hash?: string } => {
  const hashIdx = href.indexOf('#')
  if (hashIdx < 0) {
    return { path: href }
  }
  return {
    path: href.slice(0, hashIdx),
    hash: href.slice(hashIdx)
  }
}

const isSkippableLinkTarget = (rawUrl: string): boolean => {
  const trimmed = rawUrl.trim()
  if (!trimmed || trimmed.startsWith('#')) {
    return true
  }
  const lowered = trimmed.toLowerCase()
  return lowered.startsWith('mailto:') || lowered.startsWith('tel:')
}

/**
 * 将相对路径解析为知识库 repo 直链（对齐后端 KnowledgeMarkdownImageRewriter）。
 */
export const resolveRelativeRepoFileUrl = (
  sourceFileRelative: string,
  rawUrl: string
): string => {
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    return trimmed
  }
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('/')
  ) {
    return normalizeRepoFileUrl(trimmed)
  }
  try {
    const decoded = decodeURIComponent(trimmed)
    const normalizedSource = sourceFileRelative.replace(/\\/g, '/')
    const slashIdx = normalizedSource.lastIndexOf('/')
    const sourceDir =
      slashIdx >= 0 ? normalizedSource.slice(0, slashIdx) : ''
    let normalizedRelative = decoded.replace(/\\/g, '/')
    if (normalizedRelative.startsWith('./')) {
      normalizedRelative = normalizedRelative.slice(2)
    }
    const baseParts = sourceDir ? sourceDir.split('/').filter(Boolean) : []
    const relParts = normalizedRelative.split('/')
    const resolved = [...baseParts]
    for (const part of relParts) {
      if (part === '..') {
        resolved.pop()
      } else if (part !== '.' && part !== '') {
        resolved.push(part)
      }
    }
    return buildRepoFileUrl(resolved.join('/'))
  } catch {
    return trimmed
  }
}

/** 从 /file/repo/** 直链反解知识库相对路径。 */
export const relativePathFromRepoFileUrl = (url: string): string | null => {
  if (!url?.includes(REPO_FILE_PATH_MARKER)) {
    return null
  }
  const markerIdx = url.indexOf(REPO_FILE_PATH_MARKER)
  let remainder = url.slice(markerIdx + REPO_FILE_PATH_MARKER.length)
  const suffixMatch = remainder.match(/[?#].*/)
  if (suffixMatch) {
    remainder = remainder.slice(0, -suffixMatch[0].length)
  }
  if (!remainder) {
    return null
  }
  try {
    return remainder
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
  } catch {
    return null
  }
}

export type RepoMarkdownLinkTarget = {
  url: string
  relativePath: string
  hash?: string
}

/** 解析知识库 Markdown 内链目标；非 .md 或外链返回 null。 */
export const parseRepoMarkdownLinkTarget = (
  href: string,
  baseRelativePath?: string
): RepoMarkdownLinkTarget | null => {
  const trimmed = href?.trim()
  if (!trimmed || trimmed.startsWith('#')) {
    return null
  }
  if (isSkippableLinkTarget(trimmed)) {
    return null
  }

  const { path, hash } = splitUrlHash(trimmed)
  if (!path.trim()) {
    return null
  }

  let resolvedUrl: string
  if (
    path.startsWith('http://') ||
    path.startsWith('https://') ||
    path.startsWith('/')
  ) {
    if (!path.includes(REPO_FILE_PATH_MARKER)) {
      return null
    }
    resolvedUrl = normalizeRepoFileUrl(path)
  } else if (baseRelativePath?.trim()) {
    resolvedUrl = resolveRelativeRepoFileUrl(baseRelativePath, path)
  } else {
    return null
  }

  const relativePath = relativePathFromRepoFileUrl(resolvedUrl)
  if (!relativePath || !isMarkdownFile(relativePath.split('/').pop())) {
    return null
  }

  return {
    url: resolvedUrl,
    relativePath,
    hash: hash || undefined
  }
}

/**
 * 将 Markdown 正文中相对图片/链接路径改写为知识库 repo 直链（对齐后端 KnowledgeMarkdownImageRewriter）。
 */
export const rewriteMarkdownRelativeRepoUrls = (
  markdown: string,
  sourceFileRelative?: string
): string => {
  if (!markdown || !sourceFileRelative?.trim()) {
    return markdown
  }
  let result = markdown.replace(
    MD_IMAGE_PATTERN,
    (_match, alt: string, rawUrl: string) =>
      `![${alt}](${resolveRelativeRepoFileUrl(sourceFileRelative, rawUrl)})`
  )
  result = result.replace(
    MD_LINK_PATTERN,
    (match, text: string, rawUrl: string) => {
      if (isSkippableLinkTarget(rawUrl)) {
        return match
      }
      const { path, hash } = splitUrlHash(rawUrl)
      if (!path.trim()) {
        return match
      }
      const resolved = resolveRelativeRepoFileUrl(sourceFileRelative, path)
      return `[${text}](${resolved}${hash ?? ''})`
    }
  )
  return result
}

/** 判断文件名是否为 Markdown（.md，忽略大小写）。 */
export const isMarkdownFile = (name?: string): boolean =>
  /\.md$/i.test((name || '').trim())

/** 从 FileDto 字段解析用于扩展名判断的文件名。 */
export const resolveMarkdownFileName = (file: {
  fullFileName?: string
  relativePath?: string
}): string => {
  if (file.relativePath?.trim()) {
    const parts = file.relativePath.split('/')
    return parts[parts.length - 1] || file.relativePath
  }
  return file.fullFileName || ''
}
