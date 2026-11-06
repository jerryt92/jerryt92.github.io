import { createApp } from 'vue'
import App from './App.vue'
import './styles/index.css'

if (window.location.pathname === '/nas' || window.location.pathname === '/nas/') {
  window.location.replace('https://jerryt92.quickconnect.cn/')
} else {
  createApp(App).mount('#app')
}
