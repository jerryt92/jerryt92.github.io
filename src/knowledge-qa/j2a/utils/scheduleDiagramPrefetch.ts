/** 首屏渲染完成后后台预热图表 Worker（不阻塞登录/首页交互） */
export const scheduleDiagramPrefetch = () => {
  const run = () => {
    void import('./diagramMarkdownRuntime').then((m) =>
      m.preloadDiagramRuntimes()
    )
  }
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 3000 })
  } else {
    setTimeout(run, 0)
  }
}
