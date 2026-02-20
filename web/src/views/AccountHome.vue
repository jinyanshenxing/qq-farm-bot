<template>
  <div class="account-home" v-loading="loading">
    <!-- 用户信息卡片 -->
    <div class="user-profile-card">
      <img class="profile-avatar" :src="`https://q.qlogo.cn/headimg_dl?dst_uin=${uin}&spec=640&img_type=jpg`" :alt="uin" />
      <div class="profile-info">
        <div class="profile-name">{{ snapshot?.userState?.name || '-' }}</div>
        <div class="profile-uin">QQ: {{ uin }}</div>
      </div>
    </div>
    <div class="info-grid">
      <div class="info-card">
        <div class="info-label">等级</div>
        <div class="info-value level">Lv{{ snapshot?.userState?.level || 0 }}</div>
      </div>
      <div class="info-card">
        <div class="info-label">金币</div>
        <div class="info-value gold">{{ formatNum(snapshot?.userState?.gold) }}</div>
      </div>
      <div class="info-card">
        <div class="info-label">经验</div>
        <div class="info-value">{{ formatNum(snapshot?.userState?.exp) }}</div>
      </div>
    </div>

    <!-- 连接状态 -->
    <div class="status-bar">
      <el-tag :type="snapshot?.status === 'running' ? 'success' : 'danger'" effect="dark" size="small" round>
        {{ snapshot?.status === 'running' ? '已连接' : '未连接' }}
      </el-tag>
      <el-button v-if="snapshot?.status !== 'running'" type="primary" size="small" @click="handleStart">启动Bot</el-button>
      <el-button v-else type="warning" size="small" @click="handleStop">停止Bot</el-button>
    </div>

    <!-- 功能开关 -->
    <div class="section-card" v-if="toggles">
      <h3 class="section-title">功能开关</h3>
      <div class="toggles-grid">
        <div class="toggle-group">
          <div class="toggle-group-title">自己农场</div>
          <div class="toggle-row">
            <span class="toggle-label">自动收获 <el-tooltip content="自动收取成熟作物" placement="top"><el-icon :size="14"><QuestionFilled /></el-icon></el-tooltip></span>
            <el-switch v-model="toggles.autoHarvest" @change="saveToggles" />
          </div>
          <div class="toggle-row">
            <span class="toggle-label">自动种植 <el-tooltip content="收获后自动种植新作物" placement="top"><el-icon :size="14"><QuestionFilled /></el-icon></el-tooltip></span>
            <el-switch v-model="toggles.autoPlant" @change="saveToggles" />
          </div>
          <div class="toggle-row">
            <span class="toggle-label">自动施肥 <el-tooltip content="种植后自动施肥加速" placement="top"><el-icon :size="14"><QuestionFilled /></el-icon></el-tooltip></span>
            <el-switch v-model="toggles.autoFertilize" @change="saveToggles" />
          </div>
          <div class="toggle-row">
            <span class="toggle-label">自动除草 <el-tooltip content="自动清除杂草" placement="top"><el-icon :size="14"><QuestionFilled /></el-icon></el-tooltip></span>
            <el-switch v-model="toggles.autoWeed" @change="saveToggles" />
          </div>
          <div class="toggle-row">
            <span class="toggle-label">自动除虫 <el-tooltip content="自动清除害虫" placement="top"><el-icon :size="14"><QuestionFilled /></el-icon></el-tooltip></span>
            <el-switch v-model="toggles.autoPest" @change="saveToggles" />
          </div>
          <div class="toggle-row">
            <span class="toggle-label">自动浇水 <el-tooltip content="自动给干旱地块浇水" placement="top"><el-icon :size="14"><QuestionFilled /></el-icon></el-tooltip></span>
            <el-switch v-model="toggles.autoWater" @change="saveToggles" />
          </div>
        </div>

        <div class="toggle-group">
          <div class="toggle-group-title">好友巡查</div>
          <div class="toggle-row">
            <span class="toggle-label">好友巡查 <el-tooltip content="定时访问好友农场" placement="top"><el-icon :size="14"><QuestionFilled /></el-icon></el-tooltip></span>
            <el-switch v-model="toggles.friendVisit" @change="saveToggles" />
          </div>
          <div class="toggle-row">
            <span class="toggle-label">自动偷菜 <el-tooltip content="偷取好友成熟作物" placement="top"><el-icon :size="14"><QuestionFilled /></el-icon></el-tooltip></span>
            <el-switch v-model="toggles.autoSteal" @change="saveToggles" />
          </div>
          <div class="toggle-row">
            <span class="toggle-label">帮忙操作 <el-tooltip content="帮好友浇水除草" placement="top"><el-icon :size="14"><QuestionFilled /></el-icon></el-tooltip></span>
            <el-switch v-model="toggles.friendHelp" @change="saveToggles" />
          </div>
          <div class="toggle-row">
            <span class="toggle-label">放虫放草 <el-tooltip content="给好友放置害虫和杂草" placement="top"><el-icon :size="14"><QuestionFilled /></el-icon></el-tooltip></span>
            <el-switch v-model="toggles.friendPest" @change="saveToggles" />
          </div>
        </div>

        <div class="toggle-group">
          <div class="toggle-group-title">系统</div>
          <div class="toggle-row">
            <span class="toggle-label">自动任务 <el-tooltip content="自动领取已完成任务" placement="top"><el-icon :size="14"><QuestionFilled /></el-icon></el-tooltip></span>
            <el-switch v-model="toggles.autoTask" @change="saveToggles" />
          </div>
          <div class="toggle-row">
            <span class="toggle-label">自动出售 <el-tooltip content="自动出售背包中果实" placement="top"><el-icon :size="14"><QuestionFilled /></el-icon></el-tooltip></span>
            <el-switch v-model="toggles.autoSell" @change="saveToggles" />
          </div>
          <div class="toggle-row">
            <span class="toggle-label">自动购买肥料 <el-tooltip content="施肥时自动购买肥料" placement="top"><el-icon :size="14"><QuestionFilled /></el-icon></el-tooltip></span>
            <el-switch v-model="toggles.autoBuyFertilizer" @change="saveToggles" />
          </div>
        </div>
      </div>
    </div>

    <!-- 今日统计 -->
    <div class="section-card" v-if="stats">
      <div class="section-header">
        <h3 class="section-title">今日统计</h3>
        <span class="section-date">{{ stats.date }}</span>
      </div>
      <div class="stats-detail-grid">
        <div class="stat-detail">
          <div class="stat-detail-icon">🌟</div>
          <div>
            <div class="stat-detail-value">{{ stats.expGained }}</div>
            <div class="stat-detail-label">获得经验</div>
          </div>
        </div>
        <div class="stat-detail">
          <div class="stat-detail-icon">🌾</div>
          <div>
            <div class="stat-detail-value">{{ stats.harvestCount }}</div>
            <div class="stat-detail-label">收获次数</div>
          </div>
        </div>
        <div class="stat-detail">
          <div class="stat-detail-icon">🥬</div>
          <div>
            <div class="stat-detail-value">{{ stats.stealCount }}</div>
            <div class="stat-detail-label">偷菜次数</div>
          </div>
        </div>
        <div class="stat-detail">
          <div class="stat-detail-icon">💧</div>
          <div>
            <div class="stat-detail-value">{{ stats.helpWater }}</div>
            <div class="stat-detail-label">帮浇水</div>
          </div>
        </div>
        <div class="stat-detail">
          <div class="stat-detail-icon">🌿</div>
          <div>
            <div class="stat-detail-value">{{ stats.helpWeed }}</div>
            <div class="stat-detail-label">帮除草</div>
          </div>
        </div>
        <div class="stat-detail">
          <div class="stat-detail-icon">💰</div>
          <div>
            <div class="stat-detail-value">{{ stats.sellGold }}</div>
            <div class="stat-detail-label">出售金币</div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="!snapshot && !loading" class="empty-state">
      <el-empty description="暂无数据，请先启动 Bot" />
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { getAccountSnapshot, updateToggles, startBot, stopBot } from '../api/index.js'
import { onEvent, offEvent } from '../socket/index.js'

const props = defineProps({ uin: String })

const loading = ref(false)
const snapshot = ref(null)
const toggles = ref(null)
const stats = ref(null)

async function fetchData() {
  loading.value = true
  try {
    const res = await getAccountSnapshot(props.uin)
    snapshot.value = res.data
    toggles.value = res.data.featureToggles ? { ...res.data.featureToggles } : null
    stats.value = res.data.dailyStats || null
  } catch { /* */ } finally {
    loading.value = false
  }
}

async function saveToggles() {
  try {
    await updateToggles(props.uin, toggles.value)
  } catch (e) {
    ElMessage.error('保存失败: ' + e.message)
  }
}

async function handleStart() {
  try { await startBot(props.uin); ElMessage.success('启动中...'); setTimeout(fetchData, 2000) }
  catch (e) { ElMessage.error(e.message) }
}

async function handleStop() {
  try { await stopBot(props.uin); ElMessage.success('已停止'); fetchData() }
  catch (e) { ElMessage.error(e.message) }
}

function formatNum(n) { return n ? Number(n).toLocaleString() : '0' }

function onStateUpdate(data) {
  if (data.userId !== props.uin) return
  if (snapshot.value) {
    snapshot.value.status = data.status
    snapshot.value.userState = data.userState
  }
}

onMounted(() => {
  fetchData()
  onEvent('bot:stateUpdate', onStateUpdate)
})
onUnmounted(() => {
  offEvent('bot:stateUpdate', onStateUpdate)
})
</script>

<style scoped>
.user-profile-card {
  display: flex;
  align-items: center;
  gap: 16px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px;
  margin-bottom: 16px;
  box-shadow: var(--shadow);
}

.profile-avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: 3px solid var(--border-strong);
  object-fit: cover;
  background: var(--bg-hover);
  flex-shrink: 0;
}

.profile-name {
  font-size: 20px;
  font-weight: 700;
  color: var(--text);
}

.profile-uin {
  font-size: 13px;
  color: var(--text-muted);
  margin-top: 4px;
}

.info-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.info-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  box-shadow: var(--shadow);
}

.info-label {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.info-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--text);
}

.info-value.gold { color: var(--color-warning); }
.info-value.level { color: var(--color-success); }
.info-value.name { font-size: 18px; }

.status-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  padding: 12px 16px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow);
}

.section-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 16px;
  box-shadow: var(--shadow);
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 16px;
}

.section-header .section-title {
  margin-bottom: 0;
}

.section-date {
  color: var(--text-muted);
  font-size: 13px;
}

/* 功能开关 */
.toggles-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
}

.toggle-group-title {
  font-size: 13px;
  color: var(--accent);
  font-weight: 600;
  margin-bottom: 12px;
}

.toggle-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 0;
}

.toggle-label {
  font-size: 14px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
}

.toggle-label .el-icon {
  color: var(--text-muted);
  cursor: help;
}

/* 今日统计 */
.stats-detail-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.stat-detail {
  display: flex;
  align-items: center;
  gap: 10px;
}

.stat-detail-icon {
  font-size: 24px;
}

.stat-detail-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--text);
}

.stat-detail-label {
  font-size: 12px;
  color: var(--text-muted);
}

.empty-state {
  padding: 60px 20px;
  text-align: center;
}

@media (max-width: 768px) {
  .user-profile-card {
    padding: 14px;
    gap: 12px;
  }

  .profile-avatar {
    width: 48px;
    height: 48px;
  }

  .profile-name {
    font-size: 17px;
  }

  .info-grid {
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }

  .info-value {
    font-size: 18px;
  }

  .toggles-grid {
    grid-template-columns: 1fr;
    gap: 16px;
  }

  .stats-detail-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
  }

  .section-card {
    padding: 14px;
  }
}
</style>
