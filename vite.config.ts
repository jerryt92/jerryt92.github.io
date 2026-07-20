import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

const rootStaticFiles = [
  'README.md',
  'README_en.md',
  'CNAME',
  '83b2e1321c1924747d373063e55ff223.txt',
  'id_ed25519.txt',
  'id_ed25519.pub'
]

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
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
}))
