<template>
	<Teleport to="body">
		<Transition name="html-preview-fade" appear>
			<div
				v-if="visible"
				ref="overlayRef"
				class="html-preview-wrapper"
				tabindex="-1"
				@keydown.esc.prevent.stop="emit('close')"
			>
				<div class="html-preview-mask" @click="emit('close')" />

				<button
					type="button"
					class="html-preview-close"
					aria-label="关闭预览"
					@click="emit('close')"
				>
					<ElIcon><Close /></ElIcon>
				</button>

				<span
					v-if="!isSingle"
					class="html-preview-btn html-preview-prev"
					:class="{ 'is-disabled': !infinite && isFirst }"
					@click="prev"
				>
					<ElIcon><ArrowLeft /></ElIcon>
				</span>

				<span
					v-if="!isSingle"
					class="html-preview-btn html-preview-next"
					:class="{ 'is-disabled': !infinite && isLast }"
					@click="next"
				>
					<ElIcon><ArrowRight /></ElIcon>
				</span>

				<div v-if="!isSingle" class="html-preview-progress">
					{{ activeIndex + 1 }} / {{ sources.length }}
				</div>

				<div class="html-preview-panel">
					<iframe
						ref="iframeRef"
						class="html-preview-frame"
						:srcdoc="currentSrcdoc"
						sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
						scrolling="auto"
						title="HTML 预览"
					/>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>

<script setup lang="ts">
import { ArrowLeft, ArrowRight, Close } from '@element-plus/icons-vue'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { ElIcon } from 'element-plus'
import {
	buildMarkdownHtmlPreviewSrcdoc,
	resizeMarkdownHtmlPreviewExpanded
} from '../utils/markdownRenderer'

const props = withDefaults(
	defineProps<{
		visible: boolean
		sources: string[]
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

const overlayRef = ref<HTMLElement>()
const iframeRef = ref<HTMLIFrameElement>()
const activeIndex = ref(0)

const isSingle = computed(() => props.sources.length <= 1)
const isFirst = computed(() => activeIndex.value <= 0)
const isLast = computed(
	() => activeIndex.value >= props.sources.length - 1
)
const currentSrcdoc = computed(() =>
	buildMarkdownHtmlPreviewSrcdoc(props.sources[activeIndex.value] ?? '')
)

const fitExpandedIframe = () => {
	const iframe = iframeRef.value
	if (!iframe) {
		return
	}
	resizeMarkdownHtmlPreviewExpanded(iframe)
}

const onIframeLoad = () => {
	fitExpandedIframe()
	bindIframeEscape()
}

const setActiveIndex = (index: number) => {
	if (!props.sources.length) {
		return
	}
	const len = props.sources.length
	let nextIndex = index
	if (props.infinite) {
		nextIndex = ((index % len) + len) % len
	} else {
		nextIndex = Math.min(Math.max(index, 0), len - 1)
	}
	activeIndex.value = nextIndex
}

const prev = () => {
	if (!props.infinite && isFirst.value) {
		return
	}
	setActiveIndex(activeIndex.value - 1)
}

const next = () => {
	if (!props.infinite && isLast.value) {
		return
	}
	setActiveIndex(activeIndex.value + 1)
}

let prevBodyOverflow = ''
let documentKeydownHandler: ((event: KeyboardEvent) => void) | null = null
let iframeKeydownHandler: ((event: KeyboardEvent) => void) | null = null

const handleEscape = (event: KeyboardEvent) => {
	if (event.key !== 'Escape') {
		return
	}
	event.preventDefault()
	event.stopPropagation()
	emit('close')
}

const bindIframeEscape = () => {
	const doc = iframeRef.value?.contentDocument
	if (!doc) {
		return
	}
	unbindIframeEscape()
	iframeKeydownHandler = handleEscape
	doc.addEventListener('keydown', iframeKeydownHandler)
}

const unbindIframeEscape = () => {
	const doc = iframeRef.value?.contentDocument
	if (doc && iframeKeydownHandler) {
		doc.removeEventListener('keydown', iframeKeydownHandler)
	}
	iframeKeydownHandler = null
}

const registerKeydownListener = () => {
	documentKeydownHandler = handleEscape
	document.addEventListener('keydown', documentKeydownHandler, true)
}

const unregisterKeydownListener = () => {
	if (documentKeydownHandler) {
		document.removeEventListener('keydown', documentKeydownHandler, true)
		documentKeydownHandler = null
	}
	unbindIframeEscape()
}

watch(
	() => props.visible,
	(visible) => {
		if (visible) {
			prevBodyOverflow = document.body.style.overflow
			document.body.style.overflow = 'hidden'
			registerKeydownListener()
			activeIndex.value = Math.min(
				Math.max(props.initialIndex, 0),
				Math.max(props.sources.length - 1, 0)
			)
			nextTick(() => overlayRef.value?.focus())
			return
		}
		unregisterKeydownListener()
		document.body.style.overflow = prevBodyOverflow
	},
	{ immediate: true }
)

watch(
	() => [props.visible, activeIndex.value, currentSrcdoc.value] as const,
	([visible]) => {
		if (!visible) {
			return
		}
		nextTick(() => {
			const iframe = iframeRef.value
			if (!iframe) {
				return
			}
			iframe.removeEventListener('load', onIframeLoad)
			iframe.addEventListener('load', onIframeLoad, { once: true })
			if (iframe.contentDocument?.readyState === 'complete') {
				fitExpandedIframe()
			}
		})
	}
)

onUnmounted(() => {
	unregisterKeydownListener()
	document.body.style.overflow = prevBodyOverflow
	iframeRef.value?.removeEventListener('load', onIframeLoad)
})
</script>

<style scoped lang="scss">
@use '../styles/dialog-overlays' as *;

.html-preview-wrapper {
	--html-preview-content-pad-x: 20px;
	--html-preview-content-pad-y: 16px;
	position: fixed;
	inset: 0;
	z-index: 2050;
	outline: none;
}

.html-preview-mask {
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

.html-preview-close {
	position: absolute;
	z-index: 3;
	top: max(var(--n-overlay-safe-inset), env(safe-area-inset-top, 0px));
	right: max(var(--n-overlay-safe-inset), env(safe-area-inset-right, 0px));
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 40px;
	height: 40px;
	padding: 0;
	border: none;
	border-radius: 50%;
	background: rgba(96, 98, 102, 0.85);
	color: #fff;
	font-size: 20px;
	cursor: pointer;

	&:hover {
		background: rgba(96, 98, 102, 1);
	}
}

.html-preview-panel {
	position: absolute;
	z-index: 1;
	top: calc(
		max(var(--n-overlay-safe-inset), env(safe-area-inset-top, 0px)) + 48px
	);
	right: max(var(--n-overlay-safe-inset), env(safe-area-inset-right, 0px));
	bottom: max(var(--n-overlay-safe-inset), env(safe-area-inset-bottom, 0px));
	left: max(var(--n-overlay-safe-inset), env(safe-area-inset-left, 0px));
	overflow: auto;
	padding: var(--html-preview-content-pad-y) var(--html-preview-content-pad-x)
		calc(var(--html-preview-content-pad-y) + 4px);
	@include n-overlay-dialog-shell;
	background: #fff;
	box-shadow: var(--n-shadow-elevation-3);
	-webkit-overflow-scrolling: touch;
}

.html-preview-frame {
	display: block;
	width: 100%;
	min-height: 100%;
	border: none;
	background: #fff;
}

.html-preview-btn,
.html-preview-progress {
	pointer-events: auto;
}

.html-preview-btn {
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

.html-preview-prev {
	top: 50%;
	left: calc(max(var(--n-overlay-safe-inset), env(safe-area-inset-left, 0px)) + 16px);
	transform: translateY(-50%);
}

.html-preview-next {
	top: 50%;
	right: calc(max(var(--n-overlay-safe-inset), env(safe-area-inset-right, 0px)) + 16px);
	transform: translateY(-50%);
}

.html-preview-progress {
	position: absolute;
	z-index: 2;
	left: 50%;
	bottom: calc(max(var(--n-overlay-safe-inset), env(safe-area-inset-bottom, 0px)) + 16px);
	transform: translateX(-50%);
	color: #fff;
	font-size: 14px;
	line-height: 1.4;
}

.html-preview-fade-enter-active .html-preview-mask,
.html-preview-fade-leave-active .html-preview-mask {
	transition: background-color 0.2s ease;
}

.html-preview-fade-enter-from .html-preview-mask,
.html-preview-fade-leave-to .html-preview-mask {
	background: transparent;
}

.html-preview-fade-enter-active .html-preview-panel,
.html-preview-fade-leave-active .html-preview-panel,
.html-preview-fade-enter-active .html-preview-close,
.html-preview-fade-leave-active .html-preview-close,
.html-preview-fade-enter-active .html-preview-btn,
.html-preview-fade-leave-active .html-preview-btn,
.html-preview-fade-enter-active .html-preview-progress,
.html-preview-fade-leave-active .html-preview-progress {
	transition: transform 0.2s ease;
}

.html-preview-fade-enter-from .html-preview-panel,
.html-preview-fade-enter-from .html-preview-close,
.html-preview-fade-enter-from .html-preview-btn,
.html-preview-fade-enter-from .html-preview-progress {
	transform: translateY(10px);
}

.html-preview-fade-leave-to .html-preview-panel,
.html-preview-fade-leave-to .html-preview-close,
.html-preview-fade-leave-to .html-preview-btn,
.html-preview-fade-leave-to .html-preview-progress {
	transform: translateY(10px);
}
</style>
