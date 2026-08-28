/**
 * 流式 Markdown 分段渲染（精简自 j2a ChatView），避免每 token 整段 v-html 重建 DOM。
 */
import {
  MARKDOWN_RENDERER_REVISION,
  renderMarkdownCached
} from './j2a/utils/markdownRenderer'
import type { KbMessage } from './types'

/** 已闭合的围栏代码块，用于切分稳定段与流式尾段 */
const FENCE_BLOCK_RE = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1\2[ \t]*(?:\n|$)/gm
/** 增量切分：delta 内出现围栏行才需要全量 regex 重扫 */
const FENCE_LINE_IN_DELTA_RE = /(^|\n)[ \t]*(`{3,}|~{3,})/

/** 流式切分段：文本 + 是否已闭合（围栏完整） */
export type StreamSegment = { text: string; complete: boolean }

/** 带预渲染 HTML 的流式段 */
export type RenderedStreamSegment = StreamSegment & { html: string }

type SegmentCacheEntry = {
  content: string
  segments: RenderedStreamSegment[]
  revision: string
}

/** 历史 assistant 消息段缓存（按 message.index） */
const assistantSegmentCache = new Map<number, SegmentCacheEntry>()

/** 当前流式 assistant 的增量切分缓存 */
let activeStreamSplitCache: {
  content: string
  segments: StreamSegment[]
} | null = null

/** 当前流式 assistant 已渲染段缓存 */
let activeStreamRenderedCache: {
  content: string
  segments: RenderedStreamSegment[]
} | null = null

/** 清空分段与 HTML 缓存（新建对话 / 切断会话时调用） */
export function resetStreamMarkdownCache() {
  activeStreamSplitCache = null
  activeStreamRenderedCache = null
  assistantSegmentCache.clear()
}

/** 将消息切分为若干已闭合段 + 末尾流式尾段 */
export function splitStreamingSegments(content: string): StreamSegment[] {
  const segments: StreamSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  FENCE_BLOCK_RE.lastIndex = 0
  while ((match = FENCE_BLOCK_RE.exec(content)) !== null) {
    const end = match.index + match[0].length
    segments.push({ text: content.slice(lastIndex, end), complete: true })
    lastIndex = end
  }
  segments.push({ text: content.slice(lastIndex), complete: false })
  return segments
}

const resetActiveStreamRenderedCache = () => {
  activeStreamRenderedCache = null
}

/** 重置流式切分缓存（流式结束补渲染前调用） */
export function resetActiveStreamSplitCache() {
  activeStreamSplitCache = null
  resetActiveStreamRenderedCache()
}

/**
 * 流式输出专用：纯追加 token 且 delta 内无新围栏行时，只延长尾段而不全量 regex。
 */
export function splitStreamingSegmentsForActiveStream(
  content: string
): StreamSegment[] {
  if (activeStreamSplitCache?.content === content) {
    return activeStreamSplitCache.segments
  }
  const prev = activeStreamSplitCache
  if (
    prev &&
    content.startsWith(prev.content) &&
    prev.segments.length > 0 &&
    !prev.segments[prev.segments.length - 1].complete
  ) {
    const delta = content.slice(prev.content.length)
    if (!FENCE_LINE_IN_DELTA_RE.test(delta)) {
      const completed = prev.segments.slice(0, -1)
      let tailStart = 0
      for (const seg of completed) {
        tailStart += seg.text.length
      }
      const segments = [
        ...completed,
        { text: content.slice(tailStart), complete: false }
      ]
      activeStreamSplitCache = { content, segments }
      return segments
    }
  }
  const segments = splitStreamingSegments(content)
  activeStreamSplitCache = { content, segments }
  return segments
}

const buildRenderedSegments = (
  content: string,
  streamingTail = false
): RenderedStreamSegment[] => {
  const segments = streamingTail
    ? splitStreamingSegmentsForActiveStream(content)
    : splitStreamingSegments(content)
  return segments.map((seg, idx) => {
    const isTail = idx === segments.length - 1 && !seg.complete
    const shouldRenderHtml = seg.complete || !isTail || !streamingTail
    return {
      ...seg,
      html: shouldRenderHtml ? renderMarkdownCached(seg.text) : ''
    }
  })
}

/** 流式 assistant：仅尾段增长时复用已闭合段对象，避免 Vue 每 token 重建 DOM */
const buildRenderedSegmentsForActiveStream = (
  content: string
): RenderedStreamSegment[] => {
  if (activeStreamRenderedCache?.content === content) {
    return activeStreamRenderedCache.segments
  }
  const rawSegments = splitStreamingSegmentsForActiveStream(content)
  const prev = activeStreamRenderedCache
  if (
    prev &&
    content.startsWith(prev.content) &&
    rawSegments.length > 0 &&
    !rawSegments[rawSegments.length - 1].complete &&
    rawSegments.length === prev.segments.length
  ) {
    const nextSegments = prev.segments.slice(0, -1)
    const tailRaw = rawSegments[rawSegments.length - 1]
    nextSegments.push({ ...tailRaw, html: '' })
    activeStreamRenderedCache = { content, segments: nextSegments }
    return nextSegments
  }

  const nextSegments: RenderedStreamSegment[] = []
  for (let idx = 0; idx < rawSegments.length; idx++) {
    const seg = rawSegments[idx]
    const isTail = idx === rawSegments.length - 1 && !seg.complete
    const prevSeg = prev?.segments[idx]
    if (
      prevSeg &&
      prevSeg.complete &&
      seg.complete &&
      prevSeg.text === seg.text
    ) {
      nextSegments.push(prevSeg)
      continue
    }
    nextSegments.push({
      ...seg,
      html: isTail ? '' : renderMarkdownCached(seg.text)
    })
  }
  activeStreamRenderedCache = { content, segments: nextSegments }
  return nextSegments
}

/** 非流式 assistant 消息：稳定段缓存 */
const buildStableAssistantSegments = (
  messageIndex: number,
  content: string
): RenderedStreamSegment[] => {
  const hit = assistantSegmentCache.get(messageIndex)
  if (
    hit?.content === content &&
    hit.revision === MARKDOWN_RENDERER_REVISION
  ) {
    return hit.segments
  }
  const segments = buildRenderedSegments(content, false)
  assistantSegmentCache.set(messageIndex, {
    content,
    segments,
    revision: MARKDOWN_RENDERER_REVISION
  })
  return segments
}

/** 构建 assistant 消息 index → 渲染段 映射 */
export function buildAssistantRenderedSegmentsMap(
  messages: KbMessage[],
  isBusy: boolean,
  activeAssistantMessageIndex: number
): Map<number, RenderedStreamSegment[]> {
  const map = new Map<number, RenderedStreamSegment[]>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.content) {
      continue
    }
    if (isBusy && message.index === activeAssistantMessageIndex) {
      map.set(
        message.index,
        buildRenderedSegmentsForActiveStream(message.content)
      )
    } else {
      map.set(
        message.index,
        buildStableAssistantSegments(message.index, message.content)
      )
    }
  }
  return map
}

/** 当前流式 assistant 尾段原文；非流式或无尾段时返回 null */
export function getActiveAssistantTailText(
  messages: KbMessage[],
  isBusy: boolean,
  activeAssistantMessageIndex: number
): string | null {
  if (!isBusy || activeAssistantMessageIndex < 0) {
    return null
  }
  const message = messages.find(
    (item) => item.index === activeAssistantMessageIndex
  )
  if (!message?.content || message.role !== 'assistant') {
    return null
  }
  const segments = splitStreamingSegmentsForActiveStream(message.content)
  const tail = segments[segments.length - 1]
  if (tail.complete) {
    return null
  }
  return tail.text
}
