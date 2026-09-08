const SVG_NS = 'http://www.w3.org/2000/svg'

/** 序列化 SVG 为可独立打开的文档字符串 */
export const serializeDiagramSvg = (svg: SVGElement): string => {
  const clone = svg.cloneNode(true) as SVGElement
  if (!clone.getAttribute('xmlns')) {
    clone.setAttribute('xmlns', SVG_NS)
  }
  return new XMLSerializer().serializeToString(clone)
}

/** 触发浏览器下载当前图表为 .svg 文件 */
export const downloadDiagramSvg = (
  svg: SVGElement,
  filename = 'diagram.svg'
) => {
  const svgString = serializeDiagramSvg(svg)
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename.endsWith('.svg') ? filename : `${filename}.svg`
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
