/** 各图表引擎（Mermaid / Vega-Lite / PlantUML）共用的浅色配色与字体约定。 */

export const DIAGRAM_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'

/** 分类/序数色板：xychart 柱条、饼图扇区、Vega 默认 scale 共用 */
export const DIAGRAM_COLOR_PALETTE = [
  '#93C5FD',
  '#FDE68A',
  '#86EFAC',
  '#C4B5FD',
  '#FDA4AF',
  '#7DD3FC',
  '#A5F3FC',
  '#FDBA74'
] as const

export const DIAGRAM_THEME_COLORS = {
  text: '#334155',
  textStrong: '#1e293b',
  title: '#0f172a',
  textMuted: '#475569',
  line: '#94a3b8',
  border: '#CBD5E1',
  grid: '#E2E8F0',
  panelBg: '#F8FAFC',
  primaryBg: '#DBEAFE',
  primaryBorder: '#93C5FD',
  secondaryBg: '#FCE7F3',
  secondaryBorder: '#F9A8D4',
  tertiaryBg: '#D1FAE5',
  tertiaryBorder: '#6EE7B7',
  noteBg: '#FEF9C3',
  noteBorder: '#FDE047',
  noteText: '#713f12',
  activationBg: '#E0F2FE',
  activationBorder: '#7DD3FC'
} as const

const PLANTUML_THEME_MARKER = '@@diagram-theme@@'

const buildPlantUmlSkinparams = () => {
  const c = DIAGRAM_THEME_COLORS
  const font = DIAGRAM_FONT_FAMILY.replace(/"/g, '')
  return [
    'skinparam backgroundColor transparent',
    'skinparam shadowing false',
    `skinparam defaultFontName ${font}`,
    'skinparam defaultFontSize 13',
    `skinparam ArrowColor ${c.line}`,
    `skinparam ArrowFontColor ${c.text}`,
    `skinparam BorderColor ${c.border}`,
    `skinparam FontColor ${c.textStrong}`,
    `skinparam TitleFontColor ${c.title}`,
    `skinparam NoteBackgroundColor ${c.noteBg}`,
    `skinparam NoteBorderColor ${c.noteBorder}`,
    `skinparam NoteFontColor ${c.noteText}`,
    'skinparam sequence {',
    `  ArrowColor ${c.line}`,
    `  LifeLineBorderColor ${c.line}`,
    `  ActorBorderColor ${c.primaryBorder}`,
    `  ActorBackgroundColor ${c.primaryBg}`,
    `  ActorFontColor ${c.textStrong}`,
    `  ParticipantBorderColor ${c.primaryBorder}`,
    `  ParticipantBackgroundColor ${c.primaryBg}`,
    `  ParticipantFontColor ${c.textStrong}`,
    `  BoxBackgroundColor ${c.panelBg}`,
    `  BoxBorderColor ${c.border}`,
    `  NoteBackgroundColor ${c.noteBg}`,
    `  NoteBorderColor ${c.noteBorder}`,
    `  NoteFontColor ${c.noteText}`,
    '}',
    'skinparam class {',
    `  BackgroundColor ${c.primaryBg}`,
    `  BorderColor ${c.primaryBorder}`,
    `  ArrowColor ${c.line}`,
    `  FontColor ${c.textStrong}`,
    `  AttributeFontColor ${c.text}`,
    '}',
    'skinparam component {',
    `  BackgroundColor ${c.primaryBg}`,
    `  BorderColor ${c.primaryBorder}`,
    `  FontColor ${c.textStrong}`,
    '}',
    'skinparam package {',
    `  BackgroundColor ${c.panelBg}`,
    `  BorderColor ${c.border}`,
    `  FontColor ${c.text}`,
    '}',
    'skinparam rectangle {',
    `  BackgroundColor ${c.primaryBg}`,
    `  BorderColor ${c.primaryBorder}`,
    `  FontColor ${c.textStrong}`,
    '}',
    'skinparam activity {',
    `  BackgroundColor ${c.primaryBg}`,
    `  BorderColor ${c.primaryBorder}`,
    `  FontColor ${c.textStrong}`,
    `  ArrowColor ${c.line}`,
    '}',
    'skinparam state {',
    `  BackgroundColor ${c.primaryBg}`,
    `  BorderColor ${c.primaryBorder}`,
    `  FontColor ${c.textStrong}`,
    `  ArrowColor ${c.line}`,
    '}',
    'skinparam usecase {',
    `  BackgroundColor ${c.primaryBg}`,
    `  BorderColor ${c.primaryBorder}`,
    `  FontColor ${c.textStrong}`,
    '}'
  ].join('\n')
}

/** 在 PlantUML 源码 @start* 后注入统一 skinparam，不覆盖 Agent 已写的 skinparam。 */
export const injectPlantUmlTheme = (source: string) => {
  if (source.includes(PLANTUML_THEME_MARKER)) {
    return source
  }
  const skinparams = `${PLANTUML_THEME_MARKER}\n${buildPlantUmlSkinparams()}`
  const startMatch = source.match(/^(\s*@start[\w]*)/im)
  if (!startMatch || startMatch.index == null) {
    return source
  }
  const insertAt = startMatch.index + startMatch[0].length
  return (
    source.slice(0, insertAt) +
    '\n' +
    skinparams +
    source.slice(insertAt)
  )
}

const MERMAID_XYCHART_THEME_VARIABLES = {
  plotColorPalette: DIAGRAM_COLOR_PALETTE.join(','),
  backgroundColor: 'transparent',
  titleColor: DIAGRAM_THEME_COLORS.title,
  dataLabelColor: DIAGRAM_THEME_COLORS.text,
  xAxisLabelColor: DIAGRAM_THEME_COLORS.text,
  yAxisLabelColor: DIAGRAM_THEME_COLORS.text,
  xAxisTitleColor: DIAGRAM_THEME_COLORS.title,
  yAxisTitleColor: DIAGRAM_THEME_COLORS.title,
  xAxisTickColor: DIAGRAM_THEME_COLORS.line,
  yAxisTickColor: DIAGRAM_THEME_COLORS.line,
  xAxisLineColor: DIAGRAM_THEME_COLORS.border,
  yAxisLineColor: DIAGRAM_THEME_COLORS.border
} as const

/** Mermaid themeVariables：流程图 / 时序图 / 饼图 / xychart 共用色板与文字色。 */
export const getMermaidThemeVariables = () => {
  const c = DIAGRAM_THEME_COLORS
  const [pie1, pie2, pie3, pie4, pie5, pie6, pie7, pie8] =
    DIAGRAM_COLOR_PALETTE
  return {
    fontFamily: DIAGRAM_FONT_FAMILY,
    fontSize: '13px',
    textColor: c.text,
    primaryColor: c.primaryBg,
    primaryTextColor: c.textStrong,
    primaryBorderColor: c.primaryBorder,
    secondaryColor: c.secondaryBg,
    secondaryTextColor: c.textStrong,
    secondaryBorderColor: c.secondaryBorder,
    tertiaryColor: c.tertiaryBg,
    tertiaryBorderColor: c.tertiaryBorder,
    lineColor: c.line,
    mainBkg: c.primaryBg,
    clusterBkg: c.panelBg,
    clusterBorder: c.border,
    nodeBorder: c.border,
    defaultLinkColor: c.line,
    titleColor: c.title,
    edgeLabelBackground: c.panelBg,
    labelBackground: c.panelBg,
    nodeTextColor: c.textStrong,
    actorBkg: c.primaryBg,
    actorBorder: c.primaryBorder,
    actorTextColor: c.textStrong,
    activationBkgColor: c.activationBg,
    activationBorderColor: c.activationBorder,
    sequenceNumberColor: c.textMuted,
    noteBkgColor: c.noteBg,
    noteBorderColor: c.noteBorder,
    noteTextColor: c.noteText,
    pie1,
    pie2,
    pie3,
    pie4,
    pie5,
    pie6,
    pie7,
    pie8,
    pieStrokeWidth: '0px',
    pieOuterStrokeWidth: '0px',
    pieStrokeColor: 'transparent',
    pieOuterStrokeColor: 'transparent',
    pieOpacity: '1',
    pieSectionTextColor: c.text,
    pieLegendTextColor: c.textMuted,
    pieTitleTextColor: c.title,
    xyChart: MERMAID_XYCHART_THEME_VARIABLES
  }
}

/** Mermaid 样式补丁：图例可读性、饼图/柱条去描边。 */
export const getMermaidThemeCss = () => `
	.legend text,
	.legendText,
	.slice text,
	.pieTitleText {
		font-weight: 500;
		fill: ${DIAGRAM_THEME_COLORS.text} !important;
	}
	.slice path,
	.pieCircle,
	.pieOuterCircle {
		stroke: none !important;
		stroke-width: 0 !important;
	}
	.edgeLabel rect {
		rx: 6px;
		ry: 6px;
	}
	g[class*="bar-plot"] rect {
		stroke-width: 0;
	}
`

/** Vega-Lite embed 配置：在 quartz 主题上覆盖色板与轴线，与 Mermaid 对齐。 */
export const getVegaLiteEmbedConfig = () => {
  const c = DIAGRAM_THEME_COLORS
  const palette = [...DIAGRAM_COLOR_PALETTE]
  return {
    background: null,
    font: DIAGRAM_FONT_FAMILY,
    view: { stroke: null },
    title: {
      color: c.title,
      fontSize: 14,
      fontWeight: 600
    },
    axis: {
      labelColor: c.text,
      titleColor: c.title,
      domainColor: c.border,
      tickColor: c.line,
      gridColor: c.grid,
      labelFontSize: 12,
      titleFontSize: 13
    },
    legend: {
      labelColor: c.textMuted,
      titleColor: c.title,
      labelFontSize: 12,
      titleFontSize: 13
    },
    range: {
      category: palette,
      ordinal: palette
    },
    mark: {
      tooltip: true
    }
  }
}
