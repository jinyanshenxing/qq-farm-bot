<template>
  <el-dialog
    v-model="dialogVisible"
    title="添加账号 - QQ 扫码登录"
    :width="isMobile ? '92%' : '480px'"
    :close-on-click-modal="false"
    @close="handleClose"
  >
    <!-- 步骤1: 输入QQ号 -->
    <div v-if="qrStatus === 'idle' || qrStatus === 'loading'">
      <el-form :model="form" label-width="100px" @submit.prevent="handleSubmit">
        <el-form-item label="QQ号" required>
          <el-input
            v-model="form.uin"
            placeholder="请输入QQ号作为标识"
            :disabled="qrStatus === 'loading' || !!initialUin"
          />
        </el-form-item>

        <el-form-item label="农场巡查">
          <el-input-number
            v-model="form.farmIntervalSec"
            :min="1"
            :max="3600"
            :step="5"
            :disabled="qrStatus === 'loading'"
          />
          <span class="unit-text">秒</span>
        </el-form-item>
        <el-form-item label="好友巡查">
          <el-input-number
            v-model="form.friendIntervalSec"
            :min="1"
            :max="3600"
            :step="5"
            :disabled="qrStatus === 'loading'"
          />
          <span class="unit-text">秒</span>
        </el-form-item>
      </el-form>
    </div>

    <!-- 步骤2: 显示二维码 -->
    <div v-else-if="qrStatus === 'pending'" class="qr-container">
      <div class="qr-hint">请使用 QQ 扫描下方二维码</div>
      <div class="qr-image-wrapper">
        <img v-if="qrBase64" :src="qrBase64" class="qr-image" alt="登录二维码" />
        <el-skeleton v-else :rows="0" animated style="width: 300px; height: 300px;" />
      </div>
      <div class="qr-tip">二维码有效时间约 3 分钟</div>
      <el-progress
        :percentage="qrCountdownPct"
        :stroke-width="4"
        :show-text="false"
        status="success"
        style="margin-top: 12px;"
      />
    </div>

    <!-- 步骤3: 扫码成功 -->
    <div v-else-if="qrStatus === 'scanned'" class="qr-container">
      <el-result icon="success" title="扫码成功" sub-title="正在登录游戏..." />
    </div>

    <!-- 错误状态 -->
    <div v-else-if="qrStatus === 'error'" class="qr-container">
      <el-result icon="error" title="扫码失败" sub-title="二维码已过期或出错，请重试">
        <template #extra>
          <el-button type="primary" @click="resetForm">重新获取</el-button>
        </template>
      </el-result>
    </div>

    <template #footer v-if="qrStatus === 'idle' || qrStatus === 'loading'">
      <el-button @click="handleClose">取消</el-button>
      <el-button
        type="primary"
        @click="handleSubmit"
        :loading="qrStatus === 'loading'"
        :disabled="!form.uin.trim()"
      >
        获取二维码
      </el-button>
    </template>
    <template #footer v-else-if="qrStatus === 'pending'">
      <el-button @click="handleClose">取消</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, watch, computed, onUnmounted } from 'vue'

const props = defineProps({
  visible: Boolean,
  qrBase64: String,
  qrStatus: String,
  qrUin: String,
  initialUin: String, // 预填的 QQ 号
})

const emit = defineEmits(['update:visible', 'confirm', 'cancel'])

// 移动端检测
const isMobile = ref(window.innerWidth <= 768)
function handleResize() {
  isMobile.value = window.innerWidth <= 768
}
window.addEventListener('resize', handleResize)
onUnmounted(() => window.removeEventListener('resize', handleResize))

const dialogVisible = computed({
  get: () => props.visible,
  set: (v) => emit('update:visible', v),
})

const form = ref({
  uin: '',
  platform: 'qq',
  farmIntervalSec: 10,
  friendIntervalSec: 10,
})

// 当对话框打开时，预填 uin
watch(() => props.visible, (visible) => {
  if (visible && props.initialUin) {
    form.value.uin = props.initialUin
  }
})

// QR 倒计时
const qrStartTime = ref(0)
const qrCountdownPct = ref(100)
let countdownTimer = null

watch(() => props.qrStatus, (status) => {
  if (status === 'pending') {
    qrStartTime.value = Date.now()
    startCountdown()
  } else {
    stopCountdown()
  }
})

function startCountdown() {
  stopCountdown()
  const TIMEOUT = 180000 // 3 分钟
  countdownTimer = setInterval(() => {
    const elapsed = Date.now() - qrStartTime.value
    qrCountdownPct.value = Math.max(0, 100 - (elapsed / TIMEOUT) * 100)
    if (elapsed >= TIMEOUT) stopCountdown()
  }, 500)
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}

onUnmounted(stopCountdown)

function handleSubmit() {
  if (!form.value.uin.trim()) return
  emit('confirm', {
    uin: form.value.uin.trim(),
    platform: form.value.platform,
    farmInterval: form.value.farmIntervalSec * 1000,
    friendInterval: form.value.friendIntervalSec * 1000,
  })
}

function handleClose() {
  emit('cancel')
  emit('update:visible', false)
}

function resetForm() {
  emit('update:visible', false)
  setTimeout(() => emit('update:visible', true), 200)
}
</script>

<style scoped>
.qr-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px 0;
}

.qr-hint {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 16px;
}

.qr-image-wrapper {
  border: 2px solid var(--border);
  border-radius: 12px;
  padding: 8px;
  background: #fff;
}

.qr-image {
  width: 280px;
  height: 280px;
  max-width: 100%;
  height: auto;
  display: block;
}

.qr-tip {
  margin-top: 12px;
  font-size: 13px;
  color: var(--text-muted);
}

.unit-text {
  margin-left: 8px;
  color: var(--text-muted);
}

@media (max-width: 768px) {
  .qr-image {
    width: 220px;
    height: auto;
  }

  .qr-container {
    padding: 8px 0;
  }
}
</style>
