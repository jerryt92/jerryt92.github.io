/** xychart 类目数达到该阈值且未声明 horizontal 时，自动改为横向条形图 */
export const XYCHART_HORIZONTAL_MIN_CATEGORIES = 11

/** Vega-Lite 多类目时自动倾斜 X 轴标签的阈值 */
export const VEGA_LITE_MULTI_CATEGORY_THRESHOLD = 8

/** 匹配 pie 扇区起始位置（用于从 title/声明行尾切开）。 */
const PIE_SLICE_START_PATTERN =
  /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"',:]+(?:\s+[^\s"',:]+)*)\s*:\s*[\d.]+/

/** 从一行文本中提取 pie 扇区片段（引号标签、未引号中文/英文标签；忽略逗号/分号分隔）。 */
const extractPieSliceSegments = (text: string): string[] => {
  const slices: string[] = []
  const pattern =
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"',:]+(?:\s+[^\s"',:]+)*)\s*:\s*([\d.]+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    slices.push(`${match[1].trim()} : ${match[2]}`)
  }
  return slices
}

/** 拆分 `title ...` 行：title 独占一行，后续扇区各占一行。 */
const splitPieTitleLine = (line: string): string[] => {
  const indent = line.match(/^[\t ]*/)?.[0] ?? ''
  const trimmed = line.trimStart()
  const titleRest = trimmed.match(/^title\b\s*(.*)$/i)?.[1] ?? ''
  const sliceStart = titleRest.search(PIE_SLICE_START_PATTERN)
  if (sliceStart < 0) {
    return [line]
  }
  const titleText = titleRest.slice(0, sliceStart).trim()
  const sliceText = titleRest.slice(sliceStart).trim()
  const slices = extractPieSliceSegments(sliceText)
  if (slices.length === 0) {
    return [line]
  }
  const titleLine = titleText
    ? `${indent}title ${titleText}`
    : `${indent}title`
  return [titleLine, ...slices.map((slice) => `${indent}${slice}`)]
}

/**
 * 拆分首行 `pie [showData] [title ...] [扇区...]`。
 * LLM 常把声明、标题与全部扇区压缩到一行。
 */
const splitPieDeclarationLine = (line: string): string[] => {
  const indent = line.match(/^[\t ]*/)?.[0] ?? ''
  const trimmed = line.trimStart()
  if (!/^pie\b/i.test(trimmed)) {
    return [line]
  }

  const hasShowData = /^pie\b\s+showData\b/i.test(trimmed)
  const rest = trimmed.replace(/^pie\b(?:\s+showData\b)?\s*/i, '').trim()
  const header = hasShowData ? `${indent}pie showData` : `${indent}pie`

  if (!rest) {
    return [header]
  }

  if (/^title\b/i.test(rest)) {
    return [header, ...splitPieTitleLine(`${indent}${rest}`)]
  }

  const sliceStart = rest.search(PIE_SLICE_START_PATTERN)
  if (sliceStart < 0) {
    return [header, `${indent}title ${rest}`]
  }

  if (sliceStart === 0) {
    const slices = extractPieSliceSegments(rest)
    return [header, ...slices.map((slice) => `${indent}${slice}`)]
  }

  const titleText = rest.slice(0, sliceStart).trim()
  const slices = extractPieSliceSegments(rest.slice(sliceStart))
  const out: string[] = [header]
  if (titleText) {
    out.push(
      /^title\b/i.test(titleText)
        ? `${indent}${titleText}`
        : `${indent}title ${titleText}`
    )
  }
  out.push(...slices.map((slice) => `${indent}${slice}`))
  return out
}

/** 将同行多个 pie 扇区拆成多行；title 行若混入扇区则拆开。 */
const splitMultiplePieSlicesOnLine = (line: string): string[] => {
  const indent = line.match(/^[\t ]*/)?.[0] ?? ''
  const trimmed = line.trimStart()
  if (!trimmed || /^pie\b/i.test(trimmed) || trimmed.startsWith('%%')) {
    return [line]
  }

  if (/^title\b/i.test(trimmed)) {
    return splitPieTitleLine(line)
  }

  const sliceStart = trimmed.search(PIE_SLICE_START_PATTERN)
  if (sliceStart > 0) {
    const prefix = trimmed.slice(0, sliceStart).trim()
    const slices = extractPieSliceSegments(trimmed.slice(sliceStart))
    if (prefix && slices.length >= 1) {
      return [
        `${indent}title ${prefix}`,
        ...slices.map((slice) => `${indent}${slice}`)
      ]
    }
  }

  const slices = extractPieSliceSegments(trimmed)
  if (slices.length <= 1) {
    return [line]
  }
  return slices.map((slice) => `${indent}${slice}`)
}

/** LLM 常把 pie 声明/标题/扇区压缩到少量行；拆开后 quotePieSliceLines 才能补引号。 */
const normalizePieMultilineSlices = (source: string) => {
  if (!/^\s*pie\b/im.test(source)) {
    return source
  }
  let pieHeaderHandled = false
  const out: string[] = []
  for (const line of source.split('\n')) {
    const trimmed = line.trimStart()
    if (!pieHeaderHandled && /^pie\b/i.test(trimmed)) {
      out.push(...splitPieDeclarationLine(line))
      pieHeaderHandled = true
      continue
    }
    out.push(...splitMultiplePieSlicesOnLine(line))
  }
  return out.join('\n')
}

/**
 * 为 pie 图中未加引号的扇区标签补引号（含括号、空格时 lexer 会失败）。
 */
const quotePieSliceLines = (source: string) => {
  if (!/^\s*pie\b/im.test(source)) {
    return source
  }
  return source
    .split('\n')
    .map((line) => {
      const match = line.match(/^(\s*)(.+?)\s*:\s*([\d.]+)\s*$/)
      if (!match) {
        return line
      }
      const [, indent, label, value] = match
      const trimmed = label.trim()
      // title / title粘连 行不当扇区处理（title\\b 在 title15 处不生效）
      if (/^title(?:\b|(?=[\d\u0080-\uffff]))/i.test(trimmed)) {
        return line
      }
      const unquoted = trimmed.replace(/^\\?["']|["']$/g, '').trim()
      if (!unquoted) {
        return line
      }
      return `${indent}"${unquoted}" : ${value}`
    })
    .join('\n')
}

/**
 * 修复 LLM 常见的 title 粘连。
 * 典型坏例：`title15趟列车余票状态分布` → `title "15趟列车余票状态分布"`
 */
const normalizeDiagramTitleKeywordSpacing = (source: string) =>
  source.replace(
    /^(\s*)title(?=[\d\u0080-\uffff])(\S.*)$/gim,
    '$1title $2'
  )

/**
 * 为含中文 / 空白 / 数字开头的标题补引号。
 */
const normalizeDiagramTitleLines = (source: string) =>
  source
    .split('\n')
    .map((line) => {
      if (line.trimStart().startsWith('%%')) {
        return line
      }
      const fixed = normalizeDiagramTitleKeywordSpacing(line)
      const match = fixed.match(/^(\s*)title\s+(.+)$/i)
      if (!match) {
        return fixed
      }
      const indent = match[1]
      const text = match[2].trim()
      if (!text) {
        return fixed
      }
      if (
        (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
        (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
      ) {
        return fixed
      }
      // 中文、空白、或以数字开头：必须加引号，否则 lexer 把 15 当独立 token
      if (/[^\u0000-\u007F]/.test(text) || /\s/.test(text) || /^\d/.test(text)) {
        const unquoted = text
          .replace(/^["']|["']$/g, '')
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
        return `${indent}title "${unquoted}"`
      }
      return fixed
    })
    .join('\n')

/** 统计方括号列表中的项数（尊重引号内的逗号）。 */
const countBracketListItems = (listContent: string) => {
  let count = 0
  let depth = 0
  let inQuote: '"' | '\'' | null = null
  let hasContent = false

  for (let i = 0; i < listContent.length; i++) {
    const ch = listContent[i]
    if (inQuote) {
      if (ch === inQuote && listContent[i - 1] !== '\\') {
        inQuote = null
      }
      if (!inQuote) {
        hasContent = true
      }
      continue
    }
    if (ch === '"' || ch === '\'') {
      inQuote = ch
      continue
    }
    if (ch === '[') {
      depth++
      hasContent = true
      continue
    }
    if (ch === ']') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (ch === ',' && depth === 0) {
      if (hasContent) {
        count++
      }
      hasContent = false
      continue
    }
    if (!/\s/.test(ch)) {
      hasContent = true
    }
  }
  if (hasContent) {
    count++
  }
  return count
}

/** xychart 声明首行（仅该行可携带 horizontal 关键字）。 */
export const getXychartDeclarationLine = (source: string) =>
  source.match(/^\s*xychart(?:-beta)?[^\n]*/im)?.[0] ?? ''

/** 解析 xychart 的 x-axis 类目数量。 */
export const countXychartCategories = (source: string) => {
  const match = source.match(/^\s*x-axis\b[^\[]*\[([\s\S]*?)\]/im)
  if (!match) {
    return 0
  }
  return countBracketListItems(match[1])
}

/** 解析 xychart 的 bar 数据点数量。 */
export const countXychartBarValues = (source: string) => {
  const match = source.match(/^\s*bar\b[^\[]*\[([\s\S]*?)\]/im)
  if (!match) {
    return 0
  }
  return countBracketListItems(match[1])
}

/** 类目计数取 x-axis 与 bar 的较大值，避免「标题 TOP15、x-axis 仅 10 项」漏触发横向。 */
export const getXychartCategoryCount = (source: string) =>
  Math.max(countXychartCategories(source), countXychartBarValues(source))

/**
 * 多类目竖向 xychart 自动改为 horizontal，避免 X 轴标签重叠。
 */
export const normalizeXychartOrientation = (source: string) => {
  if (!/^\s*xychart(?:-beta)?\b/im.test(source)) {
    return source
  }
  if (/\bhorizontal\b/i.test(getXychartDeclarationLine(source))) {
    return source
  }
  if (getXychartCategoryCount(source) < XYCHART_HORIZONTAL_MIN_CATEGORIES) {
    return source
  }
  return source.replace(
    /^(\s*xychart(?:-beta)?)(?!\s+horizontal)\b/im,
    '$1 horizontal'
  )
}

export const isXychartSource = (source: string) =>
  /^\s*xychart(?:-beta)?\b/im.test(source)

export const isXychartHorizontal = (source: string) =>
  isXychartSource(source) &&
  /\bhorizontal\b/i.test(getXychartDeclarationLine(source))

const FLOWCHART_ARROW =
  '(?:-->|---|===|-\\.->|==>|--o|--x)'

const splitChainedFlowchartEdgesOnLine = (line: string) => {
  const indent = line.match(/^[\t ]*/)?.[0] ?? ''
  const splitOnce = (input: string) => {
    let cur = input
    // 形状闭合后接下一边：B["x"] C --> D / B["x"] C["y"] --> D
    cur = cur.replace(
      new RegExp(
        `([\\]\\)\\}])([ \\t]+)([A-Za-z_][\\w-]*(?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\})?)([ \\t]*)(${FLOWCHART_ARROW}(?:\\|[^|\\n]+\\|)?)`,
        'g'
      ),
      '$1\n$3$4$5'
    )
    // 裸节点 ID 结束一边后接下一边：Pass --> Enriched Enriched --> CQT
    cur = cur.replace(
      new RegExp(
        `((?:${FLOWCHART_ARROW})(?:\\|[^|\\n]+\\|)?[ \\t]+[A-Za-z_][\\w-]*)([ \\t]+)(?=[A-Za-z_][\\w-]*[ \\t]*${FLOWCHART_ARROW})`,
        'g'
      ),
      '$1\n'
    )
    return cur
  }

  let cur = line
  let prev = ''
  while (prev !== cur) {
    prev = cur
    cur = splitOnce(cur)
  }

  return cur
    .split('\n')
    .map((part, index) => (index === 0 ? part : indent + part.trimStart()))
    .join('\n')
}

const shouldNormalizeFlowchartLine = (trimmed: string) => {
  if (!trimmed || trimmed.startsWith('%%')) {
    return false
  }
  if (
    /^(?:style|classDef|class|linkStyle|click|subgraph|end)\b/i.test(trimmed)
  ) {
    return false
  }
  const arrowMatches = trimmed.match(
    /(?:-->|---|===|-\.->|==>|--o|--x)/g
  )
  return (arrowMatches?.length ?? 0) >= 2
}

const countLeadingSpaces = (line: string) => {
  const prefix = line.match(/^[\t ]*/)?.[0] ?? ''
  let n = 0
  for (const ch of prefix) {
    n += ch === '\t' ? 4 : 1
  }
  return n
}

const detectMindmapIndentStep = (lines: string[]) => {
  const indents = [
    ...new Set(
      lines.map((l) => countLeadingSpaces(l)).filter((i) => i > 0)
    )
  ].sort((a, b) => a - b)
  if (indents.length >= 2 && indents[1] - indents[0] > 0) {
    return indents[1] - indents[0]
  }
  return 2
}

const normalizeMindmapIndentation = (source: string) => {
  if (!/^\s*mindmap\b/im.test(source)) {
    return source
  }

  const lines = source.split('\n')
  const indentStep = detectMindmapIndentStep(lines)
  const out: string[] = []
  const stack: number[] = []
  let rootIndent = -1
  let seenRoot = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      out.push(line)
      continue
    }
    if (/^mindmap$/i.test(trimmed)) {
      out.push(line)
      continue
    }

    const indent = countLeadingSpaces(line)

    if (!seenRoot) {
      seenRoot = true
      rootIndent = indent
      stack.length = 0
      stack.push(rootIndent)
      out.push(line)
      continue
    }

    let fixedIndent = indent

    if (indent <= rootIndent) {
      fixedIndent = stack[stack.length - 1] + indentStep
    } else {
      while (stack.length > 1 && indent <= stack[stack.length - 1]) {
        stack.pop()
      }
      if (indent <= stack[stack.length - 1]) {
        fixedIndent = stack[stack.length - 1] + indentStep
      }
    }

    while (stack.length > 1 && fixedIndent <= stack[stack.length - 1]) {
      stack.pop()
    }
    stack.push(fixedIndent)
    out.push(' '.repeat(fixedIndent) + trimmed)
  }

  return out.join('\n')
}

const splitMultipleFlowchartNodeDefsOnLine = (line: string) => {
  const indent = line.match(/^[\t ]*/)?.[0] ?? ''
  const nodePatterns = [
    /([A-Za-z_][\w-]*\[[^\]]*\])([ \t]*)(?=[A-Za-z_][\w-]*)/g,
    /([A-Za-z_][\w-]*\([^)]*\))([ \t]*)(?=[A-Za-z_][\w-]*)/g,
    /([A-Za-z_][\w-]*\{[^}]*\})([ \t]*)(?=[A-Za-z_][\w-]*)/g
  ]

  let cur = line
  let prev = ''
  while (prev !== cur) {
    prev = cur
    for (const pattern of nodePatterns) {
      cur = cur.replace(pattern, '$1\n')
    }
  }

  return cur
    .split('\n')
    .map((part, index) => (index === 0 ? part : indent + part.trimStart()))
    .join('\n')
}

const shouldNormalizeFlowchartNodeLine = (trimmed: string) => {
  if (!trimmed || trimmed.startsWith('%%')) {
    return false
  }
  if (
    /^(?:style|classDef|class|linkStyle|click|subgraph|end|graph|flowchart)\b/i.test(
      trimmed
    )
  ) {
    return false
  }
  const nodeLike =
    /[A-Za-z_][\w-]*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})/g
  const matches = trimmed.match(nodeLike)
  if ((matches?.length ?? 0) >= 2) {
    return true
  }
  return /[A-Za-z_][\w-]*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})[ \t]*(?=[A-Za-z_][\w-]*(?:\s*(?:-->|---|===|-\.->|==>|--o|--x)|\s*(?:\[|\(|\{)))/.test(trimmed)
}

const normalizeFlowchartMultilineNodeDefs = (source: string) => {
  if (!/^\s*(?:graph|flowchart)\s/im.test(source)) {
    return source
  }
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (!shouldNormalizeFlowchartNodeLine(trimmed)) {
        return line
      }
      return splitMultipleFlowchartNodeDefsOnLine(line)
    })
    .join('\n')
}

const normalizeFlowchartMultilineEdges = (source: string) => {
  if (!/^\s*(?:graph|flowchart)\s/im.test(source)) {
    return source
  }
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (!shouldNormalizeFlowchartLine(trimmed)) {
        return line
      }
      return splitChainedFlowchartEdgesOnLine(line)
    })
    .join('\n')
}

const normalizeFlowchartSubgraphLabels = (source: string) => {
  if (!/^\s*(?:graph|flowchart)\s/im.test(source)) {
    return source
  }
  let counter = 0
  return source.replace(
    /^(\s*)subgraph\s*([^\[\n]+?)\s*$/gm,
    (match, indent: string, rest: string) => {
      const trimmed = rest.trim()
      if (!trimmed || /^end\b/i.test(trimmed)) {
        return match
      }
      if (/^[A-Za-z_][\w-]*\s*\[/.test(trimmed)) {
        return match
      }
      counter += 1
      return `${indent}subgraph _sg${counter} [${trimmed}]`
    }
  )
}

/** flowchart/graph 方向声明后同行还有内容时拆成两行（LLM 常挤扁）。 */
const normalizeFlowchartHeaderLine = (source: string) => {
  if (!/^\s*(?:graph|flowchart)\s/im.test(source)) {
    return source
  }
  return source.replace(
    /^(\s*(?:flowchart|graph)\s+(?:TB|TD|BT|LR|RL))\b([ \t]+)(\S[^\n]*)$/gim,
    '$1\n$3'
  )
}

/**
 * 在 flowchart 同行中把 subgraph / end 拆到新行。
 * 尊重引号与括号内的文本，避免拆坏标签。
 */
const normalizeMidlineFlowKeywords = (source: string) => {
  if (!/^\s*(?:graph|flowchart)\s/im.test(source)) {
    return source
  }
  return source
    .split('\n')
    .map((line) => {
      const indent = line.match(/^[\t ]*/)?.[0] ?? ''
      const trimmed = line.trimStart()
      if (!trimmed || trimmed.startsWith('%%')) {
        return line
      }

      let inQuote: '"' | '\'' | null = null
      let bracketDepth = 0
      let parenDepth = 0
      let braceDepth = 0
      let out = ''

      for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i]
        if (inQuote) {
          out += ch
          if (ch === inQuote && trimmed[i - 1] !== '\\') {
            inQuote = null
          }
          continue
        }
        if (ch === '"' || ch === '\'') {
          inQuote = ch
          out += ch
          continue
        }
        if (ch === '[') {
          bracketDepth++
          out += ch
          continue
        }
        if (ch === ']') {
          bracketDepth = Math.max(0, bracketDepth - 1)
          out += ch
          continue
        }
        if (ch === '(') {
          parenDepth++
          out += ch
          continue
        }
        if (ch === ')') {
          parenDepth = Math.max(0, parenDepth - 1)
          out += ch
          continue
        }
        if (ch === '{') {
          braceDepth++
          out += ch
          continue
        }
        if (ch === '}') {
          braceDepth = Math.max(0, braceDepth - 1)
          out += ch
          continue
        }

        const insideShape = bracketDepth > 0 || parenDepth > 0 || braceDepth > 0
        if (!insideShape) {
          const kw = trimmed.slice(i).match(/^(subgraph|end)\b/i)
          if (
            kw &&
            i > 0 &&
            /[\s;]/.test(trimmed[i - 1]) &&
            !/(?:^|\n)\s*$/.test(out)
          ) {
            out = out.replace(/\s+$/, '') + '\n' + indent
            out += kw[0]
            i += kw[0].length - 1
            continue
          }
        }
        out += ch
      }

      if (out === trimmed) {
        return line
      }
      return indent + out
    })
    .join('\n')
}

/**
 * sequenceDiagram 块级语句关键词（挤扁时需拆到新行）。
 * `end`/`and` 另做前瞻，避免拆开英文消息里的同形词。
 */
const SEQUENCE_STMT_KEYWORD_PATTERN =
  /^(participant|actor|alt|else|opt|loop|par|critical|option|break|rect|autonumber|activate|deactivate|note)\b/i

/**
 * sequenceDiagram 箭头消息起始：Actor->>Actor（冒号可后置，消息文本到下一语句边界）。
 */
const SEQUENCE_ARROW_START_PATTERN =
  /^([A-Za-z_][\w]*)\s*(<<->>|<<-->>|<<-|<<-->|->>|-->>|-->|->|--x|-x|--\)|-\))\s*([A-Za-z_][\w]*)/

/**
 * 判断当前位置是否应作为 sequenceDiagram 新语句起点拆行。
 * @param rest 从候选起点到行尾的剩余文本
 * @param linePrefix 本行已输出前缀（含先前拆出的换行），用于判断是否已有未闭合块
 */
const isSequenceStatementBoundary = (rest: string, linePrefix: string) => {
  // end：仅当本行此前已出现 alt/loop 等块关键词，且 end 后为空或下一语句时才拆
  // （避免 "send end signal" / "noop end"；跨行的 `alt` + `noop end` 不拆，Mermaid 可接受）
  const endMatch = rest.match(/^end\b/i)
  if (endMatch) {
    const hasOpenBlock = /\b(alt|else|opt|loop|par|rect|critical|break)\b/i.test(linePrefix)
    if (!hasOpenBlock) {
      return false
    }
    const after = rest.slice(endMatch[0].length)
    if (/^\s*$/.test(after)) {
      return true
    }
    if (!/^\s+/.test(after)) {
      return false
    }
    const next = after.trimStart()
    return (
      SEQUENCE_STMT_KEYWORD_PATTERN.test(next) ||
      SEQUENCE_ARROW_START_PATTERN.test(next) ||
      /^end\b/i.test(next)
    )
  }
  // and：避免 "save and sync"；真正的 par/and 其后多为描述或箭头
  const andMatch = rest.match(/^and\b/i)
  if (andMatch) {
    const after = rest.slice(andMatch[0].length)
    if (/^\s*$/.test(after)) {
      return true
    }
    if (!/^\s+/.test(after)) {
      return false
    }
    const next = after.trimStart()
    if (
      SEQUENCE_STMT_KEYWORD_PATTERN.test(next) ||
      SEQUENCE_ARROW_START_PATTERN.test(next)
    ) {
      return true
    }
    if (/[^\u0000-\u007f]/.test(next)) {
      return true
    }
    return SEQUENCE_ARROW_START_PATTERN.test(next) || /\s+[A-Za-z_][\w]*\s*(->>|-->>|-->|->)/.test(next)
  }
  return (
    SEQUENCE_STMT_KEYWORD_PATTERN.test(rest) ||
    SEQUENCE_ARROW_START_PATTERN.test(rest)
  )
}

/**
 * 把 sequenceDiagram 同行内的 participant / 箭头消息 / alt|else|end 等拆成多行。
 * 应对 LLM 或管道丢换行后 `end` 落在消息旁导致的 Parse error。
 */
const splitSequenceDiagramCrowdedLine = (line: string, lineContext = '') => {
  const indent = line.match(/^[\t ]*/)?.[0] ?? ''
  const trimmed = line.trimStart()
  if (!trimmed || trimmed.startsWith('%%')) {
    return line
  }

  let inQuote: '"' | '\'' | null = null
  let out = ''

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (inQuote) {
      out += ch
      if (ch === inQuote && trimmed[i - 1] !== '\\') {
        inQuote = null
      }
      continue
    }
    if (ch === '"' || ch === '\'') {
      inQuote = ch
      out += ch
      continue
    }

    // 语句边界：前导空白后跟关键词或箭头消息时插入换行
    if (
      i > 0 &&
      /\s/.test(trimmed[i - 1]) &&
      isSequenceStatementBoundary(trimmed.slice(i), `${lineContext}\n${out}`)
    ) {
      out = out.replace(/\s+$/, '') + '\n' + indent
    }
    out += ch
  }

  if (out === trimmed) {
    return line
  }
  return indent + out
}

/**
 * sequenceDiagram 同行关键词/箭头拆行（与 flowchart 的 midline 修复对称）。
 */
const normalizeMidlineSequenceKeywords = (source: string) => {
  if (!/^\s*sequenceDiagram\b/im.test(source)) {
    return source
  }
  const lines = source.split('\n')
  const out: string[] = []
  let lineContext = ''
  for (const line of lines) {
    const normalizedLine = splitSequenceDiagramCrowdedLine(line, lineContext)
    out.push(normalizedLine)
    if (/(?:^|\n)\s*end\s*(?:\n|$)/i.test(normalizedLine)) {
      lineContext = ''
    } else if (/\belse\b/i.test(normalizedLine)) {
      lineContext += `\n${normalizedLine}`
    }
  }
  return out.join('\n')
}

/**
 * 标签（引号 / [] / () / {}）内的真实换行转为 Mermaid 认可的 <br/>。
 */
const normalizeLabelHardBreaks = (source: string) => {
  let result = ''
  let inQuote: '"' | '\'' | null = null
  let bracketDepth = 0
  let parenDepth = 0
  let braceDepth = 0

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (inQuote) {
      if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && source[i + 1] === '\n') {
          i++
        }
        result += '<br/>'
        continue
      }
      result += ch
      if (ch === inQuote && source[i - 1] !== '\\') {
        inQuote = null
      }
      continue
    }

    if (ch === '"' || ch === '\'') {
      inQuote = ch
      result += ch
      continue
    }

    const inShape = bracketDepth > 0 || parenDepth > 0 || braceDepth > 0
    if (inShape && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && source[i + 1] === '\n') {
        i++
      }
      result += '<br/>'
      continue
    }

    if (ch === '[') {
      bracketDepth++
    } else if (ch === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
    } else if (ch === '(') {
      parenDepth++
    } else if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
    } else if (ch === '{') {
      braceDepth++
    } else if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
    }
    result += ch
  }
  return result
}

/** flowchart/graph 末尾未闭合的引号/括号软闭合，救活 LLM 截断图。 */
const softCloseUnbalancedDelimiters = (source: string) => {
  if (!/^\s*(?:graph|flowchart)\s/im.test(source)) {
    return source
  }
  const closers: string[] = []
  let inQuote: '"' | '\'' | null = null
  let bracketDepth = 0
  let parenDepth = 0
  let braceDepth = 0

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (inQuote) {
      if (ch === inQuote && source[i - 1] !== '\\') {
        inQuote = null
      }
      continue
    }
    if (ch === '"' || ch === '\'') {
      inQuote = ch
      continue
    }
    if (ch === '[') {
      bracketDepth++
    } else if (ch === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
    } else if (ch === '(') {
      parenDepth++
    } else if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
    } else if (ch === '{') {
      braceDepth++
    } else if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
    }
  }

  if (inQuote) {
    closers.push(inQuote)
  }
  while (braceDepth-- > 0) {
    closers.push('}')
  }
  while (parenDepth-- > 0) {
    closers.push(')')
  }
  while (bracketDepth-- > 0) {
    closers.push(']')
  }
  if (closers.length === 0) {
    return source
  }
  return source.replace(/\s*$/, '') + closers.join('')
}

/** subgraph 标签闭合后同行正文拆到下一行：`subgraph a [标签] A-->B`。 */
const normalizeFlowchartSubgraphInlineBody = (source: string) => {
  if (!/^\s*(?:graph|flowchart)\s/im.test(source)) {
    return source
  }
  return source.replace(
    /^(\s*subgraph\b[^\n\[]*\[[^\]]*\])[ \t]+(\S[^\n]*)$/gim,
    (_match, head: string, rest: string) => {
      const indent = head.match(/^[\t ]*/)?.[0] ?? ''
      return `${head}\n${indent}${rest}`
    }
  )
}

/** 去掉 flowchart 尾部明显半截行（未闭合括号/引号、悬挂箭头）。 */
const dropIncompleteFlowchartTrailingLines = (source: string) => {
  if (!/^\s*(?:graph|flowchart)\s/im.test(source)) {
    return source
  }
  const lines = source.split('\n')
  while (lines.length > 1) {
    const last = lines[lines.length - 1].trim()
    if (
      !last ||
      /^%%/.test(last) ||
      /(?:-->|---|===|-\.->|==>|--o|--x)\s*$/.test(last) ||
      /\[[^\]]*$/.test(last) ||
      /\([^)]*$/.test(last) ||
      /\{[^}]*$/.test(last) ||
      /"[^"]*$/.test(last) ||
      /'[^']*$/.test(last)
    ) {
      lines.pop()
      continue
    }
    break
  }
  return lines.join('\n')
}

/** 激进修复：从「未软闭合」底稿去掉半截行后再软闭合。 */
const aggressiveRepairMermaidSource = (baseWithoutSoftClose: string) => {
  const dropped = dropIncompleteFlowchartTrailingLines(baseWithoutSoftClose)
  return softCloseUnbalancedDelimiters(normalizeLabelHardBreaks(dropped))
}

/**
 * 规范化底稿（不含软闭合），供标准路径与激进候选共用。
 */
const normalizeMermaidSourceBase = (source: string) => {
  let text = source
    .replace(/\r\n/g, '\n')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035]/g, '\'')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, '\'')
    .replace(/：/g, ':')
    .replace(/\u00a0/g, ' ')
  text = normalizeMindmapIndentation(text)
  // title 粘连须在 pie 拆分前处理，否则 title15... 不会被识别为标题行。
  // 标题补引号放在 pie 拆分后，避免把同一行的扇区误包进 title。
  text = normalizeDiagramTitleKeywordSpacing(text)
  text = normalizeFlowchartHeaderLine(text)
  text = normalizeMidlineFlowKeywords(text)
  text = normalizeFlowchartSubgraphLabels(text)
  text = normalizeFlowchartSubgraphInlineBody(text)
  text = normalizeFlowchartMultilineNodeDefs(text)
  text = normalizeFlowchartMultilineEdges(text)
  text = normalizeMidlineSequenceKeywords(text)
  text = normalizeLabelHardBreaks(text)
  text = normalizePieMultilineSlices(text)
  text = quotePieSliceLines(text)
  // pie/xychart 拆分后又可能冒出未加引号 title，再跑一次保证幂等
  text = normalizeDiagramTitleLines(text)
  return normalizeXychartOrientation(text)
}

/**
 * 规范化 LLM 生成的 Mermaid 源码，修复弯引号、全角冒号、转义引号等常见导致解析失败的问题。
 */
export const normalizeMermaidSource = (source: string) =>
  softCloseUnbalancedDelimiters(normalizeMermaidSourceBase(source))

/**
 * 生成 Mermaid 渲染候选（标准归一化 + 激进修复），供 Worker/主线程依次试渲染。
 */
export const buildMermaidRenderCandidates = (source: string): string[] => {
  const base = normalizeMermaidSourceBase(source)
  const primary = softCloseUnbalancedDelimiters(base)
  const aggressive = aggressiveRepairMermaidSource(base)
  const candidates = [primary]
  if (aggressive !== primary) {
    candidates.push(aggressive)
  }
  return candidates
}

/**
 * 判断 Mermaid 返回的 SVG 是否为内置错误图。
 */
export const isMermaidErrorSvg = (svg: string) =>
  /aria-roledescription=["']error["']/.test(svg) ||
  /<(?:g|svg)[^>]*\sclass=["'][^"']*\berror-icon\b/.test(svg)

/**
 * 规范化 LLM 生成的 Vega-Lite JSON 源码，修复弯引号、HTML 实体等常见解析问题。
 */
export const normalizeVegaLiteSource = (source: string) =>
  source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035]/g, '\'')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, '\'')
    .trim()

/** 多类目 nominal/ordinal X 轴自动倾斜标签（不覆盖 Agent 已配置的 axis）。 */
export const enhanceVegaLiteSpec = (spec: Record<string, unknown>) => {
  const encoding = spec.encoding as Record<string, unknown> | undefined
  if (!encoding?.x || typeof encoding.x !== 'object' || Array.isArray(encoding.x)) {
    return spec
  }
  const xEnc = encoding.x as Record<string, unknown>
  const xType = xEnc.type as string | undefined
  if (xType && xType !== 'nominal' && xType !== 'ordinal') {
    return spec
  }

  let categoryCount = 0
  const data = spec.data as { values?: unknown[] } | undefined
  if (Array.isArray(data?.values)) {
    const field = typeof xEnc.field === 'string' ? xEnc.field : ''
    if (field) {
      const unique = new Set(
        data.values.map((row) =>
          row && typeof row === 'object'
            ? (row as Record<string, unknown>)[field]
            : undefined
        )
      )
      categoryCount = unique.size
    } else {
      categoryCount = data.values.length
    }
  }
  if (categoryCount < VEGA_LITE_MULTI_CATEGORY_THRESHOLD) {
    return spec
  }

  const existingAxis =
    xEnc.axis && typeof xEnc.axis === 'object' && !Array.isArray(xEnc.axis)
      ? (xEnc.axis as Record<string, unknown>)
      : {}
  if (existingAxis.labelAngle != null) {
    return spec
  }

  return {
    ...spec,
    encoding: {
      ...encoding,
      x: {
        ...xEnc,
        axis: {
          ...existingAxis,
          labelAngle: -45,
          labelLimit: 120
        }
      }
    }
  }
}

/** 非抛错解析 Vega-Lite；源码未就绪（流式/非法 JSON）时返回 null。 */
export const tryParseVegaLiteSpec = (
  source: string
): Record<string, unknown> | null => {
  try {
    return parseVegaLiteSpec(source)
  } catch {
    return null
  }
}

/** 将代码块内容解析为 Vega-Lite 规格对象。 */
export const parseVegaLiteSpec = (source: string): Record<string, unknown> => {
  const text = normalizeVegaLiteSource(source)
  if (!text) {
    throw new Error('Vega-Lite 规格不能为空')
  }
  try {
    const spec = JSON.parse(text) as unknown
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error('Vega-Lite 规格必须是 JSON 对象')
    }
    return enhanceVegaLiteSpec(spec as Record<string, unknown>)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Vega-Lite')) {
      throw error
    }
    throw new Error('Vega-Lite 规格必须是合法 JSON')
  }
}

export type DiagramRenderType = 'mermaid' | 'plantuml' | 'vegalite'
