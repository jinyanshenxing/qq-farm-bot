<template>
  <div class="logs-view">
    <div class="section-card">
      <div class="logs-header">
        <h3 class="section-title">运行日志</h3>
        <div class="logs-actions">
          <el-switch v-model="autoScroll" active-text="自动滚动" inactive-text="" size="small" />
          <el-button size="small" @click="clearLogs">清空</el-button>
        </div>
      </div>

      <div class="log-container" ref="logContainer">
        <div v-if="logs.length === 0" class="empty-hint">暂无日志</div>
        <div
          v-for="(entry, idx) in logs"
          :key="idx"
          class="log-line"
          :class="getLogClass(entry)"
        >
          <span class="log-time">{{ entry.time || '' }}</span>
          <span class="log-tag" v-if="entry.tag">[{{ entry.tag }}]</span>
          <span class="log-msg">{{ entry.msg || '' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { io } from 'socket.io-client'
import { getAccountLogs } from '../api/index.js'

const props = defineProps({ uin: String })

const logs = ref([])
const autoScroll = ref(true)
const logContainer = ref(null)
let socket = null

function getLogClass(entry) {
  if (!entry) return ''
  // 优先根据 level 字段判断
  if (entry.level === 'warn') return 'log-warn'
  if (entry.level === 'error') return 'log-error'
  // 再根据内容判断
  const m = (entry.msg || '').toLowerCase()
  if (m.includes('错误') || m.includes('失败')) return 'log-error'
  if (m.includes('警告')) return 'log-warn'
  if (m.includes('成功') || m.includes('收获') || m.includes('偷取')) return 'log-success'
  return ''
}

function scrollToBottom() {
  if (!autoScroll.value || !logContainer.value) return
  nextTick(() => {
    logContainer.value.scrollTop = logContainer.value.scrollHeight
  })
}

function clearLogs() {
  logs.value = []
}

async function fetchInitialLogs() {
  try {
    const res = await getAccountLogs(props.uin)
    logs.value = res.data || []
    scrollToBottom()
  } catch { /* */ }
}

function setupSocket() {
  const baseURL = window.location.protocol + '//' + window.location.hostname + ':3000'
  socket = io(baseURL, { transports: ['websocket'] })

  socket.on('connect', () => {
    // 订阅该账号的日志房间
    socket.emit('logs:subscribe', props.uin)
  })

  socket.on('bot:log', (data) => {
    // 服务端字段是 userId 而非 uin
    if (String(data.userId) !== String(props.uin)) return
    logs.value.push(data)
    // 限制最大日志条数
    if (logs.value.length > 2000) {
      logs.value = logs.value.slice(-1500)
    }
    scrollToBottom()
  })

  // 服务端也会推送 logs:history
  socket.on('logs:history', (data) => {
    if (String(data.uin) !== String(props.uin)) return
    logs.value = data.logs || []
    scrollToBottom()
  })
}

watch(() => props.uin, (newUin, oldUin) => {
  logs.value = []
  if (socket && socket.connected) {
    if (oldUin) socket.emit('logs:unsubscribe', oldUin)
    socket.emit('logs:subscribe', newUin)
  }
  fetchInitialLogs()
})

onMounted(() => {
  fetchInitialLogs()
  setupSocket()
})

onUnmounted(() => {
  if (socket) {
    socket.emit('logs:unsubscribe', props.uin)
    socket.disconnect()
    socket = null
  }
})
</script>

<style scoped>
.section-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  box-shadow: var(--shadow);
}

.logs-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
}

.logs-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.log-container {
  background: var(--bg-base);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  height: calc(100vh - 260px);
  min-height: 300px;
  overflow-y: auto;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.7;
}

.log-container::-webkit-scrollbar {
  width: 6px;
}

.log-container::-webkit-scrollbar-thumb {
  background: var(--border-strong);
  border-radius: 3px;
}

.empty-hint {
  color: var(--text-faint);
  text-align: center;
  padding: 40px 0;
}

.log-line {
  color: var(--text-muted);
  white-space: pre-wrap;
  word-break: break-all;
  padding: 2px 0;
  display: flex;
  gap: 6px;
}

.log-time {
  color: var(--text-faint);
  flex-shrink: 0;
}

.log-tag {
  color: var(--accent);
  flex-shrink: 0;
}

.log-msg {
  color: inherit;
}

.log-error {
  color: var(--color-danger);
}

.log-error .log-tag {
  color: var(--color-danger);
}

.log-warn {
  color: var(--color-warning);
}

.log-warn .log-tag {
  color: var(--color-warning);
}

.log-success {
  color: var(--color-success);
}

.log-success .log-tag {
  color: var(--color-success);
}

@media (max-width: 768px) {
  .section-card {
    padding: 12px;
  }

  .log-container {
    height: calc(100vh - 220px);
    font-size: 12px;
  }
}
</style>
