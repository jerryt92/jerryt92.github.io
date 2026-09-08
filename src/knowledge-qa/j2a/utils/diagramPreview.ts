import { DIAGRAM_FONT_FAMILY } from './diagramTheme'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 为预览用 SVG 铺一层白色底，避免全屏查看时透明区域发灰/发黑 */
export const appendSvgWhiteBackground = (svg: SVGElement) => {
  const viewBox = (svg as SVGSVGElement).viewBox?.baseVal
  let x = 0
  let y = 0
  let width = 800
  let height = 600
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
    x = viewBox.x
    y = viewBox.y
    width = viewBox.width
    height = viewBox.height
  } else {
    const attrW = Number.parseFloat(svg.getAttribute('width') || '')
    const attrH = Number.parseFloat(svg.getAttribute('height') || '')
    if (!Number.isNaN(attrW) && attrW > 0) {
      width = attrW
    }
    if (!Number.isNaN(attrH) && attrH > 0) {
      height = attrH
    }
  }
  const rect = document.createElementNS(SVG_NS, 'rect')
  rect.setAttribute('x', String(x))
  rect.setAttribute('y', String(y))
  rect.setAttribute('width', String(width))
  rect.setAttribute('height', String(height))
  rect.setAttribute('fill', '#ffffff')
  svg.insertBefore(rect, svg.firstChild)
}

/** 内联字体，保证 foreignObject 内中文在独立预览上下文中可读 */
const injectSvgPreviewFontStyles = (svg: SVGElement) => {
  const style = document.createElementNS(SVG_NS, 'style')
  style.textContent = `
    foreignObject div,
    foreignObject span,
    foreignObject p {
      font-family: ${DIAGRAM_FONT_FAMILY};
    }
    text {
      font-family: ${DIAGRAM_FONT_FAMILY};
    }
  `
  svg.insertBefore(style, svg.firstChild)
}

/**
 * 克隆气泡内 SVG 供全屏内联预览（恢复 viewBox 原始尺寸，去掉 fit 缩放）。
 * 须内联挂载到 DOM，不可序列化为 blob 后用 img 展示（foreignObject 会失效）。
 */
export const cloneSvgForPreview = (svg: SVGElement): SVGElement => {
  const clone = svg.cloneNode(true) as SVGElement
  clone.style.transform = ''
  clone.style.transformOrigin = ''
  clone.style.maxWidth = ''
  clone.style.maxHeight = ''
  clone.style.width = ''
  clone.style.height = ''
  clone.style.margin = ''
  const viewBox = (svg as SVGSVGElement).viewBox?.baseVal
  if (viewBox?.width > 0 && viewBox?.height > 0) {
    clone.setAttribute('width', String(viewBox.width))
    clone.setAttribute('height', String(viewBox.height))
  } else {
    clone.removeAttribute('width')
    clone.removeAttribute('height')
  }
  appendSvgWhiteBackground(clone)
  injectSvgPreviewFontStyles(clone)
  clone.style.display = 'block'
  clone.style.maxWidth = '100%'
  clone.style.maxHeight = '100%'
  return clone
}
