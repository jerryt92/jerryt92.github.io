import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

const rootStaticFiles = [
  'README.md',
  'README_en.md',
  'CNAME',
  '83b2e1321c1924747d373063e55ff223.txt',
  'ebc4ab71480c71b88bbf8045ef485b08.txt',
  'id_ed25519.txt',
  'id_ed25519.pub'
]

/** 本地开发代理目标（与 config.backendBaseUrl 保持一致） */
const J2AGENT_PROXY_TARGET =
  process.env.VITE_J2AGENT_PROXY_TARGET || 'https://j2agent.jerryt92.top'

function copyRootStaticFiles(): Plugin {
  return {
    name: 'copy-root-static-files',
    closeBundle() {
      const outDir = resolve('dist')

      for (const file of rootStaticFiles) {
        const source = resolve(file)
        if (!existsSync(source)) {
          continue
        }

        const target = resolve(outDir, file)
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(source, target)
      }
    }
  }
}

export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : './',
  plugins: [vue(), copyRootStaticFiles()],
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler'
      }
    }
  },
  optimizeDeps: {
    include: ['element-plus', 'mermaid', 'lodash-es', 'markdown-it']
  },
  worker: {
    format: 'es'
  },
  server: {
    proxy: {
      // 同源转发 REST / 知识库文件，规避浏览器 CORS
      '/v1': {
        target: J2AGENT_PROXY_TARGET,
        changeOrigin: true,
        secure: true
      },
      '/ws': {
        target: J2AGENT_PROXY_TARGET,
        changeOrigin: true,
        ws: true,
        secure: true
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000
  }
}))
