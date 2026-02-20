<template>
  <el-card class="account-list-card">
    <template #header>
      <div class="card-header">
        <span class="card-title">账号管理</span>
        <el-button type="primary" @click="$emit('add')" :icon="Plus">
          添加账号
        </el-button>
      </div>
    </template>

    <!-- 桌面端: 表格视图 -->
    <el-table
      :data="accounts"
      v-loading="loading"
      stripe
      style="width: 100%"
      empty-text="暂无账号，点击「添加账号」开始"
      class="desktop-table"
    >
      <!-- 状态 -->
      <el-table-column label="状态" width="100" align="center">
        <template #default="{ row }">
          <el-tag
            :type="statusTagType(row.status)"
            effect="dark"
            size="small"
            round
          >
            {{ statusText(row.status) }}
          </el-tag>
        </template>
      </el-table-column>

      <!-- QQ号 -->
      <el-table-column label="QQ号" prop="uin" width="140" />

      <!-- 昵称 -->
      <el-table-column label="昵称" width="140">
        <template #default="{ row }">
          {{ row.nickname || '-' }}
        </template>
      </el-table-column>

      <!-- 等级 -->
      <el-table-column label="等级" width="80" align="center">
        <template #default="{ row }">
          <el-tag type="success" effect="plain" size="small" v-if="row.level">
            Lv{{ row.level }}
          </el-tag>
          <span v-else>-</span>
        </template>
      </el-table-column>

      <!-- 金币 -->
      <el-table-column label="金币" width="120" align="right">
        <template #default="{ row }">
          <span class="gold-text" v-if="row.gold">{{ formatNumber(row.gold) }}</span>
          <span v-else>-</span>
        </template>
      </el-table-column>

      <!-- 经验 -->
      <el-table-column label="经验" width="120" align="right">
        <template #default="{ row }">
          <span v-if="row.exp">{{ formatNumber(row.exp) }}</span>
          <span v-else>-</span>
        </template>
      </el-table-column>



      <!-- 运行时长 -->
      <el-table-column label="运行时长" width="120" align="center">
        <template #default="{ row }">
          <span v-if="row.status === 'running' && row.uptime">
            {{ formatUptime(row.uptime) }}
          </span>
          <span v-else>-</span>
        </template>
      </el-table-column>

      <!-- 错误信息 -->
      <el-table-column label="信息" min-width="160">
        <template #default="{ row }">
          <span v-if="row.errorMessage" class="error-text">{{ row.errorMessage }}</span>
          <span v-else-if="row.status === 'running'" class="success-text">正常运行中</span>
          <span v-else class="muted-text">-</span>
        </template>
      </el-table-column>

      <!-- 操作 -->
      <el-table-column label="操作" width="260" fixed="right" align="center">
        <template #default="{ row }">
          <el-button-group>
            <el-button
              v-if="row.status !== 'running'"
              type="success"
              size="small"
              @click="$emit('start', row.uin)"
              :icon="VideoPlay"
            >
              启动
            </el-button>
            <el-button
              v-if="row.status === 'running'"
              type="warning"
              size="small"
              @click="$emit('stop', row.uin)"
              :icon="VideoPause"
            >
              停止
            </el-button>
            <el-button
              type="info"
              size="small"
              @click="$emit('view-logs', row)"
              :icon="Document"
            >
              日志
            </el-button>
            <el-button
              type="danger"
              size="small"
              @click="$emit('delete', row.uin)"
              :icon="Delete"
              plain
            >
              删除
            </el-button>
          </el-button-group>
        </template>
      </el-table-column>
    </el-table>

    <!-- 移动端: 卡片视图 -->
    <div class="mobile-cards" v-loading="loading">
      <div v-if="accounts.length === 0 && !loading" class="mobile-empty">
        暂无账号，点击「添加账号」开始
      </div>
      <el-card
        v-for="row in accounts"
        :key="row.uin"
        class="mobile-account-card"
        shadow="hover"
      >
        <div class="mobile-card-header">
          <div class="mobile-card-info">
            <el-tag
              :type="statusTagType(row.status)"
              effect="dark"
              size="small"
              round
            >
              {{ statusText(row.status) }}
            </el-tag>
            <span class="mobile-uin">{{ row.uin }}</span>
            <span class="mobile-nickname" v-if="row.nickname">{{ row.nickname }}</span>
          </div>
        </div>

        <div class="mobile-card-stats">
          <div class="mobile-stat" v-if="row.level">
            <span class="mobile-stat-label">等级</span>
            <el-tag type="success" effect="plain" size="small">Lv{{ row.level }}</el-tag>
          </div>
          <div class="mobile-stat" v-if="row.gold">
            <span class="mobile-stat-label">金币</span>
            <span class="gold-text">{{ formatNumber(row.gold) }}</span>
          </div>
          <div class="mobile-stat" v-if="row.exp">
            <span class="mobile-stat-label">经验</span>
            <span>{{ formatNumber(row.exp) }}</span>
          </div>
          <div class="mobile-stat" v-if="row.status === 'running' && row.uptime">
            <span class="mobile-stat-label">运行时长</span>
            <span>{{ formatUptime(row.uptime) }}</span>
          </div>
        </div>

        <div class="mobile-card-msg" v-if="row.errorMessage">
          <span class="error-text">{{ row.errorMessage }}</span>
        </div>
        <div class="mobile-card-msg" v-else-if="row.status === 'running'">
          <span class="success-text">正常运行中</span>
        </div>

        <div class="mobile-card-actions">
          <el-button
            v-if="row.status !== 'running'"
            type="success"
            size="small"
            @click="$emit('start', row.uin)"
            :icon="VideoPlay"
          >启动</el-button>
          <el-button
            v-if="row.status === 'running'"
            type="warning"
            size="small"
            @click="$emit('stop', row.uin)"
            :icon="VideoPause"
          >停止</el-button>
          <el-button
            type="info"
            size="small"
            @click="$emit('view-logs', row)"
            :icon="Document"
          >日志</el-button>
          <el-button
            type="danger"
            size="small"
            @click="$emit('delete', row.uin)"
            :icon="Delete"
            plain
          >删除</el-button>
        </div>
      </el-card>
    </div>
  </el-card>
</template>

<script setup>
import { Plus, VideoPlay, VideoPause, Document, Delete } from '@element-plus/icons-vue'

defineProps({
  accounts: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
})

defineEmits(['add', 'start', 'stop', 'delete', 'view-logs', 'config'])

function statusTagType(status) {
  const map = {
    running: 'success',
    connecting: 'warning',
    'qr-pending': 'warning',
    stopped: 'info',
    idle: 'info',
    error: 'danger',
  }
  return map[status] || 'info'
}

function statusText(status) {
  const map = {
    running: '运行中',
    connecting: '连接中',
    'qr-pending': '扫码中',
    stopped: '已停止',
    idle: '空闲',
    error: '异常',
  }
  return map[status] || status
}

function formatNumber(n) {
  if (n == null) return '-'
  return Number(n).toLocaleString()
}

function formatUptime(ms) {
  if (!ms) return '-'
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}
</script>

<style scoped>
.account-list-card {
  margin-bottom: 20px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.card-title {
  font-size: 16px;
  font-weight: 600;
}

.gold-text {
  color: #E6A23C;
  font-weight: 600;
}

.error-text {
  color: #F56C6C;
  font-size: 12px;
}

.success-text {
  color: #67C23A;
  font-size: 12px;
}

.muted-text {
  color: #C0C4CC;
}

/* 移动端卡片默认隐藏 */
.mobile-cards {
  display: none;
}

/* ============ 移动端适配 ============ */
@media (max-width: 768px) {
  .desktop-table {
    display: none !important;
  }

  .mobile-cards {
    display: block;
  }

  .mobile-empty {
    text-align: center;
    color: #909399;
    padding: 40px 0;
    font-size: 14px;
  }

  .mobile-account-card {
    margin-bottom: 12px;
  }

  .mobile-account-card :deep(.el-card__body) {
    padding: 14px;
  }

  .mobile-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
  }

  .mobile-card-info {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .mobile-uin {
    font-weight: 600;
    font-size: 14px;
    color: #303133;
  }

  .mobile-nickname {
    color: #909399;
    font-size: 13px;
  }

  .mobile-card-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 8px;
    font-size: 13px;
  }

  .mobile-stat {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .mobile-stat-label {
    color: #909399;
    font-size: 12px;
  }

  .mobile-card-msg {
    margin-bottom: 10px;
  }

  .mobile-card-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .mobile-card-actions .el-button {
    flex: 1;
    min-width: 0;
  }
}
</style>
