<template>
  <Teleport to="body">
    <Transition name="diagram-preview-fade" appear>
      <div
        v-if="visible"
        ref="overlayRef"
        class="diagram-preview-wrapper"
        tabindex="-1"
      >
        <div
          class="diagram-preview-mask"
          @click="emit('close')"
        />

        <span
          v-if="!isSingle"
          class="diagram-preview-btn diagram-preview-prev"
          :class="{ 'is-disabled': !infinite && isFirst }"
          @click="prev"
        >
          <ElIcon>
            <ArrowLeft />
          </ElIcon>
        </span>

        <span
          v-if="!isSingle"
          class="diagram-preview-btn diagram-preview-next"
          :class="{ 'is-disabled': !infinite && isLast }"
          @click="next"
        >
          <ElIcon>
            <ArrowRight />
          </ElIcon>
        </span>

        <div
          v-if="!isSingle"
          class="diagram-preview-progress"
        >
          {{ activeIndex + 1 }} / {{ diagrams.length }}
        </div>

        <div class="diagram-preview-actions">
          <div class="diagram-preview-actions__inner">
            <ElIcon @click="handleActions('zoomOut')">
              <ZoomOut />
            </ElIcon>
            <ElIcon @click="handleActions('zoomIn')">
              <ZoomIn />
            </ElIcon>
            <i class="diagram-preview-actions__divider" />
            <ElIcon @click="toggleMode">
              <component :is="mode.icon" />
            </ElIcon>
            <i class="diagram-preview-actions__divider" />
            <ElIcon @click="handleActions('anticlockwise')">
              <RefreshLeft />
            </ElIcon>
            <ElIcon @click="handleActions('clockwise')">
              <RefreshRight />
            </ElIcon>
            <i class="diagram-preview-actions__divider" />
            <ElIcon
              :class="{ 'is-disabled': savingSvg }"
              :title="t('diagramPreview.saveSvg')"
              @click="saveActiveDiagramSvg"
            >
              <Download />
            </ElIcon>
          </div>
        </div>

        <div class="diagram-preview-canvas">
          <div
            class="diagram-preview-stage"
            :style="stageStyle"
            @mousedown="handleMouseDown"
          >
            <div
              ref="hostRef"
              class="diagram-preview-host"
              :class="{
                'diagram-preview-host--contain': mode.name === 'contain',
                'diagram-preview-host--original': mode.name === 'original'
              }"
            />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import {
  ArrowLeft,
  ArrowRight,
  Download,
  FullScreen,
  RefreshLeft,
  RefreshRight,
  ScaleToOriginal,
  ZoomIn,
  ZoomOut
} from '@element-plus/icons-vue'
import { t } from '../shims/lib'
import { throttle } from 'lodash-es'
import { computed, markRaw, nextTick, onUnmounted, ref, shallowRef, watch } from 'vue'
import { ElIcon, ElMessage } from 'element-plus'
import { downloadDiagramSvg } from '../utils/diagramExport'

const ZOOM_RATE = 1.2
const MIN_SCALE = 0.2
const MAX_SCALE = 7
const ROTATE_DEG = 90

const modes = {
  CONTAIN: {
    name: 'contain',
    icon: markRaw(FullScreen)
  },
  ORIGINAL: {
    name: 'original',
    icon: markRaw(ScaleToOriginal)
  }
} as const

type ViewerMode = (typeof modes)[keyof typeof modes]
type TransformState = {
  scale: number
  deg: number
  offsetX: number
  offsetY: number
  enableTransition: boolean
}

const props = withDefaults(
  defineProps<{
    visible: boolean
    diagrams: SVGElement[]
    initialIndex?: number
    infinite?: boolean
  }>(),
  {
    initialIndex: 0,
    infinite: true
  }
)

const emit = defineEmits<{
  close: []
}>()

const overlayRef = ref<HTMLElement | null>(null)
const hostRef = ref<HTMLElement | null>(null)
const activeIndex = ref(props.initialIndex)
const savingSvg = ref(false)
const mode = shallowRef<ViewerMode>(modes.CONTAIN)
const transform = ref<TransformState>({
  scale: 1,
  deg: 0,
  offsetX: 0,
  offsetY: 0,
  enableTransition: false
})

let prevBodyOverflow = ''
let keydownHandler: ((event: KeyboardEvent) => void) | null = null
let wheelHandler: ((event: WheelEvent) => void) | null = null

const isSingle = computed(() => props.diagrams.length <= 1)
const isFirst = computed(() => activeIndex.value === 0)
const isLast = computed(
  () => activeIndex.value === props.diagrams.length - 1
)

const stageStyle = computed(() => {
  const { scale, deg, offsetX, offsetY, enableTransition } = transform.value
  let translateX = offsetX / scale
  let translateY = offsetY / scale
  const radian = (deg * Math.PI) / 180
  const cosRadian = Math.cos(radian)
  const sinRadian = Math.sin(radian)
  translateX = translateX * cosRadian + translateY * sinRadian
  translateY = translateY * cosRadian - (offsetX / scale) * sinRadian
  return {
    transform: `scale(${scale}) rotate(${deg}deg) translate(${translateX}px, ${translateY}px)`,
    transition: enableTransition ? 'transform 0.3s' : ''
  }
})

const resetTransform = () => {
  transform.value = {
    scale: 1,
    deg: 0,
    offsetX: 0,
    offsetY: 0,
    enableTransition: false
  }
}

const mountActiveDiagram = () => {
  const host = hostRef.value
  if (!host) {
    return
  }
  host.replaceChildren()
  const svg = props.diagrams[activeIndex.value]
  if (!(svg instanceof SVGElement)) {
    return
  }
  host.appendChild(svg)
}

const prev = () => {
  if (isFirst.value && !props.infinite) {
    return
  }
  const len = props.diagrams.length
  if (!len) {
    return
  }
  activeIndex.value = (activeIndex.value - 1 + len) % len
}

const next = () => {
  if (isLast.value && !props.infinite) {
    return
  }
  const len = props.diagrams.length
  if (!len) {
    return
  }
  activeIndex.value = (activeIndex.value + 1) % len
}

const toggleMode = () => {
  const modeNames = Object.keys(modes) as Array<keyof typeof modes>
  const currentIndex = modeNames.findIndex(
    (name) => modes[name].name === mode.value.name
  )
  const nextModeName = modeNames[(currentIndex + 1) % modeNames.length]
  mode.value = modes[nextModeName]
  resetTransform()
}

const saveActiveDiagramSvg = async () => {
  if (savingSvg.value) {
    return
  }
  const svg = props.diagrams[activeIndex.value]
  if (!(svg instanceof SVGElement)) {
    return
  }
  savingSvg.value = true
  try {
    const suffix = props.diagrams.length > 1 ? `-${activeIndex.value + 1}` : ''
    downloadDiagramSvg(svg, `diagram${suffix}.svg`)
  } catch {
    ElMessage.error(t('diagramPreview.saveSvg.failed'))
  } finally {
    savingSvg.value = false
  }
}

const handleActions = (
  action: 'zoomIn' | 'zoomOut' | 'clockwise' | 'anticlockwise',
  options: { enableTransition?: boolean } = {}
) => {
  const enableTransition = options.enableTransition ?? true
  switch (action) {
    case 'zoomOut':
      if (transform.value.scale > MIN_SCALE) {
        transform.value.scale = Number.parseFloat(
          (transform.value.scale / ZOOM_RATE).toFixed(3)
        )
      }
      break
    case 'zoomIn':
      if (transform.value.scale < MAX_SCALE) {
        transform.value.scale = Number.parseFloat(
          (transform.value.scale * ZOOM_RATE).toFixed(3)
        )
      }
      break
    case 'clockwise':
      transform.value.deg += ROTATE_DEG
      break
    case 'anticlockwise':
      transform.value.deg -= ROTATE_DEG
      break
  }
  transform.value.enableTransition = enableTransition
}

const handleMouseDown = (event: MouseEvent) => {
  if (event.button !== 0) {
    return
  }
  transform.value.enableTransition = false
  const { offsetX, offsetY } = transform.value
  const startX = event.pageX
  const startY = event.pageY

  const onMouseMove = throttle((moveEvent: MouseEvent) => {
    transform.value = {
      ...transform.value,
      offsetX: offsetX + moveEvent.pageX - startX,
      offsetY: offsetY + moveEvent.pageY - startY
    }
  })

  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
  }

  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
  event.preventDefault()
}

const registerListeners = () => {
  keydownHandler = throttle((event: KeyboardEvent) => {
    switch (event.code) {
      case 'Escape':
        emit('close')
        break
      case 'Space':
        event.preventDefault()
        toggleMode()
        break
      case 'ArrowLeft':
        prev()
        break
      case 'ArrowUp':
        handleActions('zoomIn')
        break
      case 'ArrowRight':
        next()
        break
      case 'ArrowDown':
        handleActions('zoomOut')
        break
    }
  })

  wheelHandler = throttle((event: WheelEvent) => {
    const delta = event.deltaY || event.deltaX
    handleActions(delta < 0 ? 'zoomIn' : 'zoomOut', { enableTransition: false })
    event.preventDefault()
  })

  document.addEventListener('keydown', keydownHandler)
  document.addEventListener('wheel', wheelHandler, { passive: false })
}

const unregisterListeners = () => {
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler)
    keydownHandler = null
  }
  if (wheelHandler) {
    document.removeEventListener('wheel', wheelHandler)
    wheelHandler = null
  }
}

watch(
  () => props.visible,
  (open) => {
    if (open) {
      activeIndex.value = props.initialIndex
      mode.value = modes.CONTAIN
      resetTransform()
      prevBodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      registerListeners()
      nextTick(() => {
        overlayRef.value?.focus()
        mountActiveDiagram()
      })
      return
    }
    unregisterListeners()
    document.body.style.overflow = prevBodyOverflow
  }
)

watch(
  () => [props.initialIndex, props.diagrams] as const,
  () => {
    if (props.visible) {
      activeIndex.value = props.initialIndex
      resetTransform()
      nextTick(mountActiveDiagram)
    }
  }
)

watch(activeIndex, () => {
  if (props.visible) {
    resetTransform()
    nextTick(mountActiveDiagram)
  }
})

onUnmounted(() => {
  unregisterListeners()
  document.body.style.overflow = prevBodyOverflow
})
</script>

<style scoped lang="scss">
.diagram-preview-wrapper {
  position: fixed;
  inset: 0;
  z-index: 2050;
  outline: none;
}

.diagram-preview-mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  transition: background-color 0.2s ease;

  &::before {
    content: '';
    position: absolute;
    inset: 0;
    backdrop-filter: blur(var(--n-glass-blur-2)) saturate(var(--n-glass-saturate));
    -webkit-backdrop-filter: blur(var(--n-glass-blur-2)) saturate(var(--n-glass-saturate));
    pointer-events: none;
  }
}

.diagram-preview-canvas {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  user-select: none;
  /* 空白区域点击穿透到遮罩，实现点击旁边关闭 */
  pointer-events: none;
}

.diagram-preview-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  cursor: grab;

  &:active {
    cursor: grabbing;
  }
}

.diagram-preview-host {
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 0;

  :deep(svg) {
    display: block;
    width: auto;
    height: auto;
  }
}

.diagram-preview-host--contain :deep(svg) {
  max-width: min(92vw, 1200px);
  max-height: 88vh;
}

.diagram-preview-host--original :deep(svg) {
  max-width: none;
  max-height: none;
}

.diagram-preview-btn,
.diagram-preview-actions,
.diagram-preview-progress {
  pointer-events: auto;
}

.diagram-preview-btn {
  position: absolute;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: rgba(96, 98, 102, 0.8);
  color: #fff;
  font-size: 24px;
  cursor: pointer;
  user-select: none;

  &:hover:not(.is-disabled) {
    background: rgba(96, 98, 102, 1);
  }

  &.is-disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
}

.diagram-preview-prev {
  top: 50%;
  left: 40px;
  transform: translateY(-50%);
}

.diagram-preview-next {
  top: 50%;
  right: 40px;
  transform: translateY(-50%);
}

.diagram-preview-progress {
  position: absolute;
  z-index: 2;
  left: 50%;
  bottom: 90px;
  transform: translateX(-50%);
  padding: 0;
  color: #fff;
  font-size: 14px;
  line-height: 1.4;
  user-select: none;
  cursor: default;
}

.diagram-preview-actions {
  position: absolute;
  z-index: 2;
  left: 50%;
  bottom: 30px;
  transform: translateX(-50%);
  height: 44px;
  padding: 0 23px;
  border-radius: 22px;
  background: rgba(96, 98, 102, 0.8);
  color: #fff;
}

.diagram-preview-actions__inner {
  display: flex;
  align-items: center;
  justify-content: space-around;
  gap: 22px;
  height: 100%;
  font-size: 23px;
  cursor: default;

  .el-icon {
    cursor: pointer;

    &.is-disabled {
      opacity: 0.35;
      cursor: not-allowed;
      pointer-events: none;
    }
  }
}

.diagram-preview-actions__divider {
  width: 1px;
  height: 20px;
  margin: 0 -6px;
  background: rgba(255, 255, 255, 0.35);
}

.diagram-preview-fade-enter-active .diagram-preview-mask,
.diagram-preview-fade-leave-active .diagram-preview-mask {
  transition: background-color 0.2s ease;
}

.diagram-preview-fade-enter-from .diagram-preview-mask,
.diagram-preview-fade-leave-to .diagram-preview-mask {
  background: transparent;
}

.diagram-preview-fade-enter-active .diagram-preview-canvas,
.diagram-preview-fade-leave-active .diagram-preview-canvas,
.diagram-preview-fade-enter-active .diagram-preview-btn,
.diagram-preview-fade-leave-active .diagram-preview-btn,
.diagram-preview-fade-enter-active .diagram-preview-progress,
.diagram-preview-fade-leave-active .diagram-preview-progress,
.diagram-preview-fade-enter-active .diagram-preview-actions,
.diagram-preview-fade-leave-active .diagram-preview-actions {
  transition: transform 0.2s ease;
}

.diagram-preview-fade-enter-from .diagram-preview-canvas,
.diagram-preview-fade-enter-from .diagram-preview-btn,
.diagram-preview-fade-enter-from .diagram-preview-progress,
.diagram-preview-fade-enter-from .diagram-preview-actions {
  transform: translateY(10px);
}

.diagram-preview-fade-leave-to .diagram-preview-canvas,
.diagram-preview-fade-leave-to .diagram-preview-btn,
.diagram-preview-fade-leave-to .diagram-preview-progress,
.diagram-preview-fade-leave-to .diagram-preview-actions {
  transform: translateY(10px);
}
</style>
