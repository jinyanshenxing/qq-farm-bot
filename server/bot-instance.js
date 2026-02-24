/**
 * BotInstance - 单个用户的农场机器人实例
 *
 * 将原始 client.js / network.js / farm.js / friend.js / task.js / warehouse.js
 * 中的 **模块级状态** 全部收拢到实例内，使得同一进程可并行运行多个 Bot。
 *
 * 共享只读资源：proto types、gameConfig 数据。
 * 每个实例独立：WebSocket 连接、userState、定时器、日志流。
 */

const EventEmitter = require('events');
const WebSocket = require('ws');
const protobuf = require('protobufjs');
const Long = require('long');
const { types } = require('../src/proto');
const { CONFIG, PlantPhase, PHASE_NAMES } = require('../src/config');
const {
    getPlantNameBySeedId, getPlantName, getPlantExp,
    formatGrowTime, getPlantGrowTime, getItemName, getFruitName,
    getPlantRanking,
} = require('../src/gameConfig');

const seedShopData = require('../tools/seed-shop-merged-export.json');
const FRUIT_ID_SET = new Set(
    ((seedShopData && seedShopData.rows) || [])
        .map(row => Number(row.fruitId))
        .filter(Number.isFinite)
);
const GOLD_ITEM_ID = 1001;
const NORMAL_FERTILIZER_ID = 1011;

// ============ 工具函数 (无状态，可复用) ============
function toLong(val) { return Long.fromNumber(val); }
function toNum(val) { if (Long.isLong(val)) return val.toNumber(); return val || 0; }
function nowStr() {
    const d = new Date();
    const pad2 = n => String(n).padStart(2, '0');
    const pad3 = n => String(n).padStart(3, '0');
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isFruitId(id) { return FRUIT_ID_SET.has(toNum(id)); }

// Tag 图标映射
const TAG_ICONS = {
    '系统': '⚙️', 'WS': '🔌', '登录': '🔑', '心跳': '💬',
    '推送': '📨', '解码': '📦', '错误': '❌',
    '农场': '🌾', '巡田': '🌾', '收获': '🌽', '种植': '🌱',
    '铲除': '🚭', '施肥': '💧', '除草': '🌿', '除虫': '🐛', '浇水': '💦',
    '解锁': '🔓', '升级': '⬆️',
    '商店': '🛒', '购买': '💰',
    '好友': '👥', '申请': '👋',
    '任务': '📝', '仓库': '📦', 'API': '🌐', '配置': '🔧',
};
function getTagIcon(tag) { return TAG_ICONS[tag] || '📌'; }

// ============ BotInstance 类 ============

class BotInstance extends EventEmitter {
    /**
     * @param {string} userId - 唯一标识 (通常用 uin / QQ号)
     * @param {object} opts
     * @param {string} opts.platform - 'qq' | 'wx'
     * @param {number} opts.farmInterval - 农场巡查间隔 ms
     * @param {number} opts.friendInterval - 好友巡查间隔 ms
     */
    constructor(userId, opts = {}) {
        super();
        this.userId = userId;
        this.platform = opts.platform || 'qq';
        this.farmInterval = opts.farmInterval || CONFIG.farmCheckInterval;
        this.friendInterval = opts.friendInterval || CONFIG.friendCheckInterval;
        this.preferredSeedId = opts.preferredSeedId || 0; // 0 = 自动选择

        // ---------- 运行状态 ----------
        this.status = 'idle'; // idle | qr-pending | connecting | running | stopped | error
        this.errorMessage = '';
        this.startedAt = null;

        // ---------- 网络层状态 ----------
        this.ws = null;
        this.clientSeq = 1;
        this.serverSeq = 0;
        this.pendingCallbacks = new Map();
        this.heartbeatTimer = null;
        this.lastHeartbeatResponse = 0;
        this.heartbeatMissCount = 0;

        // ---------- 用户游戏状态 ----------
        this.userState = { gid: 0, name: '', level: 0, gold: 0, exp: 0 };
        this.serverTimeMs = 0;
        this.localTimeAtSync = 0;

        // ---------- 农场循环 ----------
        this.farmLoopRunning = false;
        this.farmCheckTimer = null;
        this.isCheckingFarm = false;

        // ---------- 好友循环 ----------
        this.friendLoopRunning = false;
        this.friendCheckTimer = null;
        this.isCheckingFriends = false;
        this.operationLimits = new Map();
        this.expTracker = new Map();
        this.expExhausted = new Set();
        this.lastResetDate = '';

        // ---------- 任务 ----------
        this.taskNotifyHandler = null;

        // ---------- 仓库 ----------
        this.sellTimer = null;

        // ---------- 每日奖励状态追踪 ----------
        this.dailyRewardState = {
            freeGifts: '',        // 商城免费礼包完成日期
            share: '',            // 分享奖励完成日期
            monthCard: '',        // 月卡奖励完成日期
            email: '',            // 邮箱奖励完成日期
            vipGift: '',          // QQ会员奖励完成日期
            illustrated: '',      // 图鉴奖励完成日期
            fertilizerBuy: '',    // 化肥购买完成日期
            fertilizerUse: '',    // 化肥礼包使用完成日期
        };
        this.lastFertilizerBuyAt = 0;  // 上次购买化肥时间
        this.dailyRoutineTimer = null; // 每日任务定时器

        // ---------- 日志缓冲 ----------
        this._logs = [];      // 最近 N 条日志
        this.MAX_LOGS = 500;

        // ---------- 功能开关 (前端可控制) ----------
        this.featureToggles = {
            // ========== 农场基础功能 ==========
            autoHarvest: true,         // 自动收获成熟作物
            autoPlant: true,           // 自动种植空地
            autoFertilize: false,       // 自动施肥
            autoWeed: true,            // 自动除草
            autoPest: true,            // 自动除虫
            autoWater: true,           // 自动浇水
            autoLandUnlock: true,      // 自动解锁新土地（开拓）
            autoLandUpgrade: true,     // 自动升级土地
            
            // ========== 好友互动功能 ==========
            friendVisit: true,         // 访问好友农场
            autoSteal: true,           // 自动偷菜
            friendHelp: true,          // 帮好友除草/除虫/浇水
            friendPest: true,          // 给好友放虫（损人）
            helpEvenExpFull: true,     // 经验满了也继续帮忙
            skipStealRadish: true,     // 偷菜时跳过白萝卜
            
            // ========== 系统功能 ==========
            autoTask: true,            // 自动完成并领取任务
            autoSell: true,            // 自动卖出仓库作物
            autoBuyFertilizer: false,   // 自动购买化肥（金币）
            
            // ========== 每日奖励功能 ==========
            autoFreeGifts: true,       // 商城免费礼包
            autoShareReward: true,     // 分享奖励
            autoMonthCard: true,       // 月卡每日奖励
            autoEmailReward: true,     // 邮箱奖励自动领取
            autoVipGift: true,         // QQ会员每日礼包
            autoIllustrated: true,     // 图鉴奖励自动领取
            autoFertilizerBuy: false,  // 点券购买化肥（消耗点券，默认关）
            autoFertilizerUse: false,   // 使用化肥礼包
        };

        // ---------- 今日统计 ----------
        this.dailyStats = {
            date: new Date().toLocaleDateString(),
            expGained: 0,
            harvestCount: 0,
            stealCount: 0,
            helpWater: 0,
            helpWeed: 0,
            helpPest: 0,
            sellGold: 0,
        };

        // ---------- 缓存的土地数据 ----------
        this._cachedLands = null;
        this._cachedLandsTime = 0;
    }

    // ================================================================
    //  日志 (替代原 console.log, 通过事件推送到 WebSocket)
    // ================================================================

    log(tag, msg) {
        const icon = getTagIcon(tag);
        const entry = { ts: Date.now(), time: nowStr(), tag, icon, msg, level: 'info' };
        this._pushLog(entry);
    }

    logWarn(tag, msg) {
        const icon = getTagIcon(tag);
        const entry = { ts: Date.now(), time: nowStr(), tag, icon, msg, level: 'warn' };
        this._pushLog(entry);
    }

    logError(tag, msg) {
        const icon = getTagIcon(tag);
        const entry = { ts: Date.now(), time: nowStr(), tag, icon, msg, level: 'error' };
        this._pushLog(entry);
    }

    _pushLog(entry) {
        this._logs.push(entry);
        if (this._logs.length > this.MAX_LOGS) this._logs.shift();
        this.emit('log', { userId: this.userId, ...entry });
    }

    getRecentLogs(n = 100) {
        return this._logs.slice(-n);
    }

    // ================================================================
    //  时间同步 (每个实例独立)
    // ================================================================

    syncServerTime(ms) {
        this.serverTimeMs = ms;
        this.localTimeAtSync = Date.now();
    }

    getServerTimeSec() {
        if (!this.serverTimeMs) return Math.floor(Date.now() / 1000);
        const elapsed = Date.now() - this.localTimeAtSync;
        return Math.floor((this.serverTimeMs + elapsed) / 1000);
    }

    toTimeSec(val) {
        const n = toNum(val);
        if (n <= 0) return 0;
        return n > 1e12 ? Math.floor(n / 1000) : n;
    }

    // ================================================================
    //  网络层
    // ================================================================

    encodeMsg(serviceName, methodName, bodyBytes) {
        const msg = types.GateMessage.create({
            meta: {
                service_name: serviceName,
                method_name: methodName,
                message_type: 1,
                client_seq: toLong(this.clientSeq),
                server_seq: toLong(this.serverSeq),
            },
            body: bodyBytes || Buffer.alloc(0),
        });
        const encoded = types.GateMessage.encode(msg).finish();
        this.clientSeq++;
        return encoded;
    }

    sendMsg(serviceName, methodName, bodyBytes, callback) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.log('WS', '连接未打开');
            return false;
        }
        const seq = this.clientSeq;
        const encoded = this.encodeMsg(serviceName, methodName, bodyBytes);
        if (callback) this.pendingCallbacks.set(seq, callback);
        this.ws.send(encoded);
        return true;
    }

    sendMsgAsync(serviceName, methodName, bodyBytes, timeout = 10000) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error(`连接未打开: ${methodName}`));
                return;
            }
            const seq = this.clientSeq;
            const timer = setTimeout(() => {
                this.pendingCallbacks.delete(seq);
                reject(new Error(`请求超时: ${methodName} (seq=${seq})`));
            }, timeout);

            const sent = this.sendMsg(serviceName, methodName, bodyBytes, (err, body, meta) => {
                clearTimeout(timer);
                if (err) reject(err);
                else resolve({ body, meta });
            });
            if (!sent) {
                clearTimeout(timer);
                reject(new Error(`发送失败: ${methodName}`));
            }
        });
    }

    handleMessage(data) {
        try {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            const msg = types.GateMessage.decode(buf);
            const meta = msg.meta;
            if (!meta) return;
            if (meta.server_seq) {
                const seq = toNum(meta.server_seq);
                if (seq > this.serverSeq) this.serverSeq = seq;
            }
            const msgType = meta.message_type;

            // Notify
            if (msgType === 3) { this.handleNotify(msg); return; }

            // Response
            if (msgType === 2) {
                const errorCode = toNum(meta.error_code);
                const clientSeqVal = toNum(meta.client_seq);
                const cb = this.pendingCallbacks.get(clientSeqVal);
                if (cb) {
                    this.pendingCallbacks.delete(clientSeqVal);
                    if (errorCode !== 0) {
                        cb(new Error(`${meta.service_name}.${meta.method_name} 错误: code=${errorCode} ${meta.error_message || ''}`));
                    } else {
                        cb(null, msg.body, meta);
                    }
                    return;
                }
                if (errorCode !== 0) {
                    this.logWarn('错误', `${meta.service_name}.${meta.method_name} code=${errorCode} ${meta.error_message || ''}`);
                }
            }
        } catch (err) {
            this.logWarn('解码', err.message);
        }
    }

    handleNotify(msg) {
        if (!msg.body || msg.body.length === 0) return;
        try {
            const event = types.EventMessage.decode(msg.body);
            const type = event.message_type || '';
            const eventBody = event.body;

            if (type.includes('Kickout')) {
                this.log('推送', `被踢下线! ${type}`);
                try {
                    const notify = types.KickoutNotify.decode(eventBody);
                    this.log('推送', `原因: ${notify.reason_message || '未知'}`);
                } catch (e) { }
                this._setStatus('error');
                this.errorMessage = '被踢下线';
                this.stop();
                return;
            }

            if (type.includes('LandsNotify')) {
                try {
                    const notify = types.LandsNotify.decode(eventBody);
                    const hostGid = toNum(notify.host_gid);
                    const lands = notify.lands || [];
                    if (lands.length > 0 && (hostGid === this.userState.gid || hostGid === 0)) {
                        this.emit('landsChanged', lands);
                    }
                } catch (e) { }
                return;
            }

            if (type.includes('ItemNotify')) {
                try {
                    const notify = types.ItemNotify.decode(eventBody);
                    const items = notify.items || [];
                    for (const itemChg of items) {
                        const item = itemChg.item;
                        if (!item) continue;
                        const id = toNum(item.id);
                        const count = toNum(item.count);
                        if (id === 1101 || id === 2) {
                            const oldExp = this.userState.exp || 0;
                            if (count > oldExp) {
                                this._checkDailyReset();
                                this.dailyStats.expGained += (count - oldExp);
                            }
                            this.userState.exp = count;
                        }
                        else if (id === 1 || id === 1001) { this.userState.gold = count; }
                    }
                    this._emitStateUpdate();
                } catch (e) { }
                return;
            }

            if (type.includes('BasicNotify')) {
                try {
                    const notify = types.BasicNotify.decode(eventBody);
                    if (notify.basic) {
                        const oldLevel = this.userState.level;
                        this.userState.level = toNum(notify.basic.level) || this.userState.level;
                        this.userState.gold = toNum(notify.basic.gold) || this.userState.gold;
                        const exp = toNum(notify.basic.exp);
                        if (exp > 0) {
                            const oldExp = this.userState.exp || 0;
                            // 仅当 exp 确实比当前值大时才计入（避免和 ItemNotify 重复）
                            if (exp > oldExp) {
                                this._checkDailyReset();
                                this.dailyStats.expGained += (exp - oldExp);
                            }
                            this.userState.exp = exp;
                        }
                        if (this.userState.level !== oldLevel) {
                            this.log('系统', `🎉 升级! Lv${oldLevel} → Lv${this.userState.level}`);
                        }
                        this._emitStateUpdate();
                    }
                } catch (e) { }
                return;
            }

            if (type.includes('FriendApplicationReceivedNotify')) {
                try {
                    const notify = types.FriendApplicationReceivedNotify.decode(eventBody);
                    const applications = notify.applications || [];
                    if (applications.length > 0) this._handleFriendApplications(applications);
                } catch (e) { }
                return;
            }

            if (type.includes('TaskInfoNotify')) {
                try {
                    const notify = types.TaskInfoNotify.decode(eventBody);
                    if (notify.task_info) this._handleTaskNotify(notify.task_info);
                } catch (e) { }
                return;
            }
        } catch (e) {
            this.logWarn('推送', `解码失败: ${e.message}`);
        }
    }

    // ================================================================
    //  登录 & 心跳
    // ================================================================

    sendLogin(onSuccess) {
        const body = types.LoginRequest.encode(types.LoginRequest.create({
            sharer_id: toLong(0),
            sharer_open_id: '',
            device_info: CONFIG.device_info,
            share_cfg_id: toLong(0),
            scene_id: '1256',
            report_data: {
                callback: '', cd_extend_info: '', click_id: '', clue_token: '',
                minigame_channel: 'other', minigame_platid: 2, req_id: '', trackid: '',
            },
        })).finish();

        this.sendMsg('gamepb.userpb.UserService', 'Login', body, (err, bodyBytes) => {
            if (err) { this.logError('登录', `登录失败: ${err.message}`); this._setStatus('error'); this.errorMessage = err.message; return; }
            try {
                const reply = types.LoginReply.decode(bodyBytes);
                if (reply.basic) {
                    this.userState.gid = toNum(reply.basic.gid);
                    this.userState.name = reply.basic.name || '未知';
                    this.userState.level = toNum(reply.basic.level);
                    this.userState.gold = toNum(reply.basic.gold);
                    this.userState.exp = toNum(reply.basic.exp);
                    if (reply.time_now_millis) this.syncServerTime(toNum(reply.time_now_millis));

                    this.log('登录', `登录成功 | 昵称: ${this.userState.name} | GID: ${this.userState.gid} | 等级: Lv${this.userState.level} | 金币: ${this.userState.gold.toLocaleString()} | 经验: ${this.userState.exp.toLocaleString()}`);
                    this._setStatus('running');
                    this._emitStateUpdate();
                }
                this.startHeartbeat();
                if (onSuccess) onSuccess();
            } catch (e) {
                this.logError('登录', `登录响应解码失败: ${e.message}`);
                this._setStatus('error');
            }
        });
    }

    startHeartbeat() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.lastHeartbeatResponse = Date.now();
        this.heartbeatMissCount = 0;

        this.heartbeatTimer = setInterval(() => {
            if (!this.userState.gid) return;
            const timeSince = Date.now() - this.lastHeartbeatResponse;
            if (timeSince > 60000) {
                this.heartbeatMissCount++;
                this.logWarn('心跳', `连接可能已断开 (${Math.round(timeSince / 1000)}s 无响应)`);
                if (this.heartbeatMissCount >= 3) {
                    this.log('心跳', '连接超时，停止运行');
                    this._setStatus('error');
                    this.errorMessage = '心跳超时';
                    this.stop();
                    return;
                }
            }
            const body = types.HeartbeatRequest.encode(types.HeartbeatRequest.create({
                gid: toLong(this.userState.gid),
                client_version: CONFIG.clientVersion,
            })).finish();
            this.sendMsg('gamepb.userpb.UserService', 'Heartbeat', body, (err, replyBody) => {
                if (err || !replyBody) return;
                this.lastHeartbeatResponse = Date.now();
                this.heartbeatMissCount = 0;
                try {
                    const reply = types.HeartbeatReply.decode(replyBody);
                    if (reply.server_time) this.syncServerTime(toNum(reply.server_time));
                } catch (e) { }
            });
        }, CONFIG.heartbeatInterval);
    }

    // ================================================================
    //  连接入口
    // ================================================================

    connect(code) {
        return new Promise((resolve, reject) => {
            this._setStatus('connecting');
            const url = `${CONFIG.serverUrl}?platform=${this.platform}&os=${CONFIG.os}&ver=${CONFIG.clientVersion}&code=${code}&openID=`;

            this.ws = new WebSocket(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
                    'Origin': 'https://gate-obt.nqf.qq.com',
                },
            });
            this.ws.binaryType = 'arraybuffer';

            this.ws.on('open', () => {
                this.log('WS', '连接已建立，正在登录...');
                this.sendLogin(async () => {
                    // 登录成功 → 启动所有功能模块
                    this.log('系统', `农场巡查间隔: ${this.farmInterval}ms | 好友巡查间隔: ${this.friendInterval}ms`);
                    this.startFarmLoop();
                    this.startFriendLoop();
                    this._initTaskSystem();
                    setTimeout(() => this._debugSellFruits(), 5000);
                    this._startSellLoop(60000);
                    this.startedAt = Date.now();
                    resolve();
                });
            });

            this.ws.on('message', (data) => {
                this.handleMessage(Buffer.isBuffer(data) ? data : Buffer.from(data));
            });

            this.ws.on('close', (code, reason) => {
                this.log('WS', `连接关闭 (code=${code})`);
                if (this.status === 'running') {
                    this._setStatus('error');
                    this.errorMessage = `连接关闭 code=${code}`;
                }
                this._cleanup();
            });

            this.ws.on('error', (err) => {
                this.logWarn('WS', `错误: ${err.message}`);
                this._setStatus('error');
                this.errorMessage = err.message;
                reject(err);
            });
        });
    }

    // ================================================================
    //  农场 API
    // ================================================================

    async getAllLands() {
        const body = types.AllLandsRequest.encode(types.AllLandsRequest.create({})).finish();
        const { body: replyBody } = await this.sendMsgAsync('gamepb.plantpb.PlantService', 'AllLands', body);
        const reply = types.AllLandsReply.decode(replyBody);
        if (reply.operation_limits) this._updateOperationLimits(reply.operation_limits);
        return reply;
    }

    async harvest(landIds) {
        const body = types.HarvestRequest.encode(types.HarvestRequest.create({
            land_ids: landIds,
            host_gid: toLong(this.userState.gid),
            is_all: true,
        })).finish();
        const { body: replyBody } = await this.sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body);
        return types.HarvestReply.decode(replyBody);
    }

    async waterLand(landIds) {
        const body = types.WaterLandRequest.encode(types.WaterLandRequest.create({
            land_ids: landIds,
            host_gid: toLong(this.userState.gid),
        })).finish();
        const { body: replyBody } = await this.sendMsgAsync('gamepb.plantpb.PlantService', 'WaterLand', body);
        return types.WaterLandReply.decode(replyBody);
    }

    async weedOut(landIds) {
        const body = types.WeedOutRequest.encode(types.WeedOutRequest.create({
            land_ids: landIds,
            host_gid: toLong(this.userState.gid),
        })).finish();
        const { body: replyBody } = await this.sendMsgAsync('gamepb.plantpb.PlantService', 'WeedOut', body);
        return types.WeedOutReply.decode(replyBody);
    }

    async insecticide(landIds) {
        const body = types.InsecticideRequest.encode(types.InsecticideRequest.create({
            land_ids: landIds,
            host_gid: toLong(this.userState.gid),
        })).finish();
        const { body: replyBody } = await this.sendMsgAsync('gamepb.plantpb.PlantService', 'Insecticide', body);
        return types.InsecticideReply.decode(replyBody);
    }

    async fertilize(landIds, fertilizerId = NORMAL_FERTILIZER_ID) {
        let successCount = 0;
        for (const landId of landIds) {
            try {
                const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                    land_ids: [toLong(landId)],
                    fertilizer_id: toLong(fertilizerId),
                })).finish();
                await this.sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
                successCount++;
            } catch (e) { break; }
            if (landIds.length > 1) await sleep(50);
        }
        return successCount;
    }

    async removePlant(landIds) {
        const body = types.RemovePlantRequest.encode(types.RemovePlantRequest.create({
            land_ids: landIds.map(id => toLong(id)),
        })).finish();
        const { body: replyBody } = await this.sendMsgAsync('gamepb.plantpb.PlantService', 'RemovePlant', body);
        return types.RemovePlantReply.decode(replyBody);
    }

    // ================================================================
    //  土地升级/解锁 API
    // ================================================================

    /**
     * 升级土地
     * @param {number} landId - 要升级的土地ID
     * @returns {Promise<Object>} 升级后的土地信息
     */
    async upgradeLand(landId) {
        const body = types.UpgradeLandRequest.encode(types.UpgradeLandRequest.create({
            land_id: toLong(landId),
        })).finish();
        const { body: replyBody } = await this.sendMsgAsync('gamepb.plantpb.PlantService', 'UpgradeLand', body);
        return types.UpgradeLandReply.decode(replyBody);
    }

    /**
     * 解锁土地（开拓新土地）
     * @param {number} landId - 要解锁的土地ID
     * @param {boolean} doShared - 是否选择共享土地
     * @returns {Promise<Object>} 解锁后的土地信息
     */
    async unlockLand(landId, doShared = false) {
        const body = types.UnlockLandRequest.encode(types.UnlockLandRequest.create({
            land_id: toLong(landId),
            do_shared: !!doShared,
        })).finish();
        const { body: replyBody } = await this.sendMsgAsync('gamepb.plantpb.PlantService', 'UnlockLand', body);
        return types.UnlockLandReply.decode(replyBody);
    }

    // ================================================================
    //  商店 & 种植
    // ================================================================

    async getShopInfo(shopId) {
        const body = types.ShopInfoRequest.encode(types.ShopInfoRequest.create({ shop_id: toLong(shopId) })).finish();
        const { body: replyBody } = await this.sendMsgAsync('gamepb.shoppb.ShopService', 'ShopInfo', body);
        return types.ShopInfoReply.decode(replyBody);
    }

    async buyGoods(goodsId, num, price) {
        const body = types.BuyGoodsRequest.encode(types.BuyGoodsRequest.create({
            goods_id: toLong(goodsId), num: toLong(num), price: toLong(price),
        })).finish();
        const { body: replyBody } = await this.sendMsgAsync('gamepb.shoppb.ShopService', 'BuyGoods', body);
        return types.BuyGoodsReply.decode(replyBody);
    }

    encodePlantRequest(seedId, landIds) {
        const writer = protobuf.Writer.create();
        const itemWriter = writer.uint32(18).fork();
        itemWriter.uint32(8).int64(seedId);
        const idsWriter = itemWriter.uint32(18).fork();
        for (const id of landIds) idsWriter.int64(id);
        idsWriter.ldelim();
        itemWriter.ldelim();
        return writer.finish();
    }

    async plantSeeds(seedId, landIds) {
        let successCount = 0;
        for (const landId of landIds) {
            try {
                const body = this.encodePlantRequest(seedId, [landId]);
                const { body: replyBody } = await this.sendMsgAsync('gamepb.plantpb.PlantService', 'Plant', body);
                types.PlantReply.decode(replyBody);
                successCount++;
            } catch (e) {
                this.logWarn('种植', `土地#${landId} 失败: ${e.message}`);
            }
            if (landIds.length > 1) await sleep(50);
        }
        return successCount;
    }

    async findBestSeed(landsCount) {
        const SEED_SHOP_ID = 2;
        const shopReply = await this.getShopInfo(SEED_SHOP_ID);
        if (!shopReply.goods_list || shopReply.goods_list.length === 0) return null;

        const state = this.userState;
        const available = [];
        for (const goods of shopReply.goods_list) {
            if (!goods.unlocked) continue;
            let meetsConditions = true;
            let requiredLevel = 0;
            for (const cond of (goods.conds || [])) {
                if (toNum(cond.type) === 1) {
                    requiredLevel = toNum(cond.param);
                    if (state.level < requiredLevel) { meetsConditions = false; break; }
                }
            }
            if (!meetsConditions) continue;
            const limitCount = toNum(goods.limit_count);
            const boughtNum = toNum(goods.bought_num);
            if (limitCount > 0 && boughtNum >= limitCount) continue;
            available.push({
                goods, goodsId: toNum(goods.id), seedId: toNum(goods.item_id),
                price: toNum(goods.price), requiredLevel,
            });
        }
        if (available.length === 0) return null;

        // 用户指定了作物 → 优先使用
        if (this.preferredSeedId) {
            const preferred = available.find(x => x.seedId === this.preferredSeedId);
            if (preferred) {
                return preferred;
            } else {
                const seedName = getPlantNameBySeedId(this.preferredSeedId) || this.preferredSeedId;
                this.logWarn('商店', `指定种子 ${seedName} 当前不可购买，回退自动选择`);
            }
        }

        if (CONFIG.forceLowestLevelCrop) {
            available.sort((a, b) => a.requiredLevel - b.requiredLevel || a.price - b.price);
            return available[0];
        }
        // 使用排行榜经验效率排序选择最优种子
        try {
            const ranking = getPlantRanking({ level: state.level, sort: 'expPerHour' });
            if (ranking.length > 0) {
                this.log('商店', `排行榜第1: ${ranking[0].name} (${ranking[0].expPerHour}经验/时, seedId:${ranking[0].seedId})`);
            }
            for (const entry of ranking) {
                const hit = available.find(x => x.seedId === entry.seedId);
                if (hit) return hit;
            }
        } catch (e) { /* fallback */ }

        if (state.level && state.level <= 28) {
            available.sort((a, b) => a.requiredLevel - b.requiredLevel);
        } else {
            available.sort((a, b) => b.requiredLevel - a.requiredLevel);
        }
        return available[0];
    }

    async autoPlantEmptyLands(deadLandIds, emptyLandIds, unlockedLandCount) {
        let landsToPlant = [...emptyLandIds];
        const state = this.userState;

        if (deadLandIds.length > 0) {
            try {
                await this.removePlant(deadLandIds);
                this.log('铲除', `已铲除 ${deadLandIds.length} 块枯死作物`);
                landsToPlant.push(...deadLandIds);
            } catch (e) {
                this.logWarn('铲除', `失败: ${e.message}`);
                landsToPlant.push(...deadLandIds);
            }
        }
        if (landsToPlant.length === 0) return;

        let bestSeed;
        try { bestSeed = await this.findBestSeed(unlockedLandCount); } catch (e) { return; }
        if (!bestSeed) return;

        const seedName = getPlantNameBySeedId(bestSeed.seedId);
        this.log('商店', `选择种子: ${seedName} (ID:${bestSeed.seedId}) | 单价: ${bestSeed.price}金币`);

        const needCount = landsToPlant.length;
        const totalCost = bestSeed.price * needCount;
        if (totalCost > state.gold) {
            const canBuy = Math.floor(state.gold / bestSeed.price);
            if (canBuy <= 0) return;
            landsToPlant = landsToPlant.slice(0, canBuy);
        }

        let actualSeedId = bestSeed.seedId;
        try {
            const buyReply = await this.buyGoods(bestSeed.goodsId, landsToPlant.length, bestSeed.price);
            if (buyReply.get_items && buyReply.get_items.length > 0) {
                const gotId = toNum(buyReply.get_items[0].id);
                if (gotId > 0) actualSeedId = gotId;
            }
            this.log('购买', `已购买 ${seedName}种子 ×${landsToPlant.length} | 花费: ${bestSeed.price * landsToPlant.length}金币`);
        } catch (e) { this.logWarn('购买', e.message); return; }

        let plantedLands = [];
        try {
            const planted = await this.plantSeeds(actualSeedId, landsToPlant);
            this.log('种植', `已在 ${planted} 块地种植 ${seedName}`);
            if (planted > 0) plantedLands = landsToPlant.slice(0, planted);
        } catch (e) { this.logWarn('种植', e.message); }

        if (plantedLands.length > 0) {
            const fertilized = await this.fertilize(plantedLands);
            if (fertilized > 0) this.log('施肥', `已为 ${fertilized}/${plantedLands.length} 块地施肥`);
        }
    }

    // ================================================================
    //  土地分析
    // ================================================================

    getCurrentPhase(phases) {
        if (!phases || phases.length === 0) return null;
        const nowSec = this.getServerTimeSec();
        for (let i = phases.length - 1; i >= 0; i--) {
            const beginTime = this.toTimeSec(phases[i].begin_time);
            if (beginTime > 0 && beginTime <= nowSec) return phases[i];
        }
        return phases[0];
    }

    analyzeLands(lands) {
        const result = {
            harvestable: [], needWater: [], needWeed: [], needBug: [],
            growing: [], empty: [], dead: [], harvestableInfo: [],
            growingDetails: [], // 每块生长中土地的详情
            unlockable: [],     // 可解锁（开拓）的土地
            upgradable: [],     // 可升级的土地
        };
        const nowSec = this.getServerTimeSec();
        for (const land of lands) {
            const id = toNum(land.id);
            
            // 未解锁的土地 → 检查是否可以解锁
            if (!land.unlocked) {
                if (land.could_unlock) {
                    result.unlockable.push(id);
                }
                continue;
            }
            
            // 已解锁的土地 → 检查是否可以升级
            if (land.could_upgrade) {
                result.upgradable.push(id);
            }
            
            const plant = land.plant;
            if (!plant || !plant.phases || plant.phases.length === 0) {
                result.empty.push(id); continue;
            }
            const currentPhase = this.getCurrentPhase(plant.phases);
            if (!currentPhase) { result.empty.push(id); continue; }
            const phaseVal = currentPhase.phase;
            const plantId = toNum(plant.id);
            const plantName = getPlantName(plantId) || plant.name || '未知';
            if (phaseVal === PlantPhase.DEAD) { result.dead.push(id); continue; }
            if (phaseVal === PlantPhase.MATURE) {
                result.harvestable.push(id);
                result.harvestableInfo.push({
                    landId: id, plantId,
                    name: plantName,
                    exp: getPlantExp(plantId),
                });
                continue;
            }
            const dryNum = toNum(plant.dry_num);
            const dryTime = this.toTimeSec(currentPhase.dry_time);
            if (dryNum > 0 || (dryTime > 0 && dryTime <= nowSec)) result.needWater.push(id);
            const weedsTime = this.toTimeSec(currentPhase.weeds_time);
            if ((plant.weed_owners && plant.weed_owners.length > 0) || (weedsTime > 0 && weedsTime <= nowSec)) result.needWeed.push(id);
            const insectTime = this.toTimeSec(currentPhase.insect_time);
            if ((plant.insect_owners && plant.insect_owners.length > 0) || (insectTime > 0 && insectTime <= nowSec)) result.needBug.push(id);
            // 计算距成熟剩余时间
            const maturePhase = plant.phases.find(p => p.phase === PlantPhase.MATURE);
            let timeLeft = '';
            if (maturePhase) {
                const matureBegin = this.toTimeSec(maturePhase.begin_time);
                if (matureBegin > nowSec) {
                    const secs = matureBegin - nowSec;
                    const h = Math.floor(secs / 3600);
                    const m = Math.floor((secs % 3600) / 60);
                    timeLeft = h > 0 ? `${h}h${m}m` : `${m}m`;
                } else {
                    timeLeft = '即将成熟';
                }
            }
            const phaseName = PHASE_NAMES[phaseVal] || '生长中';
            result.growingDetails.push({ landId: id, name: plantName, phase: phaseName, timeLeft });
            result.growing.push(id);
        }
        return result;
    }

    // ================================================================
    //  农场巡查循环
    // ================================================================

    async checkFarm() {
        if (this.isCheckingFarm || !this.userState.gid) return;
        this.isCheckingFarm = true;
        try {
            const landsReply = await this.getAllLands();
            if (!landsReply.lands || landsReply.lands.length === 0) { this.log('农场', '没有土地数据'); return; }

            const lands = landsReply.lands;
            const status = this.analyzeLands(lands);
            const unlockedCount = lands.filter(l => l && l.unlocked).length;

            const statusParts = [];
            if (status.harvestable.length) statusParts.push(`🌽收获:${status.harvestable.length}`);
            if (status.needWeed.length) statusParts.push(`🌿草:${status.needWeed.length}`);
            if (status.needBug.length) statusParts.push(`🐛虫:${status.needBug.length}`);
            if (status.needWater.length) statusParts.push(`💦水:${status.needWater.length}`);
            if (status.dead.length) statusParts.push(`💫枯:${status.dead.length}`);
            if (status.empty.length) statusParts.push(`⬜空:${status.empty.length}`);
            statusParts.push(`🌱生长:${status.growing.length}`);

            const hasWork = status.harvestable.length || status.needWeed.length || status.needBug.length
                || status.needWater.length || status.dead.length || status.empty.length;

            const actions = [];
            const batchOps = [];
            if (status.needWeed.length > 0) batchOps.push(this.weedOut(status.needWeed).then(() => actions.push(`🌿除草×${status.needWeed.length}`)).catch(e => this.logWarn('除草', e.message)));
            if (status.needBug.length > 0) batchOps.push(this.insecticide(status.needBug).then(() => actions.push(`🐛除虫×${status.needBug.length}`)).catch(e => this.logWarn('除虫', e.message)));
            if (status.needWater.length > 0) batchOps.push(this.waterLand(status.needWater).then(() => actions.push(`💦浇水×${status.needWater.length}`)).catch(e => this.logWarn('浇水', e.message)));
            if (batchOps.length > 0) await Promise.all(batchOps);

            let harvestedLandIds = [];
            if (status.harvestable.length > 0) {
                try {
                    await this.harvest(status.harvestable);
                    actions.push(`🌽收获×${status.harvestable.length}`);
                    harvestedLandIds = [...status.harvestable];
                    this._checkDailyReset();
                    this.dailyStats.harvestCount += status.harvestable.length;
                }
                catch (e) { this.logWarn('收获', e.message); }
            }

            const allDead = [...status.dead, ...harvestedLandIds];
            const allEmpty = [...status.empty];
            if (allDead.length > 0 || allEmpty.length > 0) {
                try { await this.autoPlantEmptyLands(allDead, allEmpty, unlockedCount); actions.push(`🌱种植×${allDead.length + allEmpty.length}`); }
                catch (e) { this.logWarn('种植', e.message); }
            }

            // ==================== 土地解锁/升级 ====================
            // 解锁新土地（开拓）
            if (this.featureToggles.autoLandUnlock && status.unlockable.length > 0) {
                let unlocked = 0;
                for (const landId of status.unlockable) {
                    try {
                        await this.unlockLand(landId, false);
                        this.log('解锁', `土地#${landId} 解锁成功`);
                        unlocked++;
                    } catch (e) {
                        this.logWarn('解锁', `土地#${landId} 解锁失败: ${e.message}`);
                    }
                    await sleep(200);
                }
                if (unlocked > 0) {
                    actions.push(`🔓解锁×${unlocked}`);
                }
            }

            // 升级已有土地
            if (this.featureToggles.autoLandUpgrade && status.upgradable.length > 0) {
                let upgraded = 0;
                for (const landId of status.upgradable) {
                    try {
                        const reply = await this.upgradeLand(landId);
                        const newLevel = reply.land ? toNum(reply.land.level) : '?';
                        this.log('升级', `土地#${landId} 升级成功 → 等级${newLevel}`);
                        upgraded++;
                    } catch (e) {
                        this.logWarn('升级', `土地#${landId} 升级失败: ${e.message}`);
                    }
                    await sleep(200);
                }
                if (upgraded > 0) {
                    actions.push(`⬆升级×${upgraded}`);
                }
            }

            const actionStr = actions.length > 0 ? ` → ${actions.join(' | ')}` : ' → 无操作';
            this.log('农场', `巡查完成 [${statusParts.join(' | ')}]${actionStr}`);

            // 打印每块地的详细信息
            if (status.harvestableInfo.length > 0) {
                const harvestNames = status.harvestableInfo.map(h => `${h.name}(+${h.exp || '?'}exp)`).join(', ');
                this.log('农场', `可收获: ${harvestNames}`);
            }
            if (status.growingDetails.length > 0) {
                // 按植物名分组显示
                const groups = new Map();
                for (const d of status.growingDetails) {
                    const key = d.name;
                    if (!groups.has(key)) groups.set(key, { count: 0, phase: d.phase, timeLeft: d.timeLeft });
                    const g = groups.get(key);
                    g.count++;
                    // 取最短剩余时间
                    if (d.timeLeft && (!g.timeLeft || d.timeLeft < g.timeLeft)) g.timeLeft = d.timeLeft;
                }
                const growParts = [];
                for (const [name, g] of groups) {
                    growParts.push(`${name}x${g.count}(${g.phase}${g.timeLeft ? ' ' + g.timeLeft + '后成熟' : ''})`);
                }
                this.log('农场', `生长中: ${growParts.join(', ')}`);
            }

            // 通知前端更新农场状态
            this._emitStateUpdate();
        } catch (err) {
            this.logWarn('巡田', `检查失败: ${err.message}`);
        } finally {
            this.isCheckingFarm = false;
        }
    }

    async farmCheckLoop() {
        while (this.farmLoopRunning) {
            await this.checkFarm();
            if (!this.farmLoopRunning) break;
            await sleep(this.farmInterval);
        }
    }

    startFarmLoop() {
        if (this.farmLoopRunning) return;
        this.farmLoopRunning = true;
        this.on('landsChanged', this._onLandsChanged.bind(this));
        this.farmCheckTimer = setTimeout(() => this.farmCheckLoop(), 2000);
    }

    _lastPushTime = 0;
    _onLandsChanged(lands) {
        if (this.isCheckingFarm) return;
        const now = Date.now();
        if (now - this._lastPushTime < 500) return;
        this._lastPushTime = now;
        setTimeout(async () => { if (!this.isCheckingFarm) await this.checkFarm(); }, 100);
    }

    // ================================================================
    //  好友 API
    // ================================================================

    async getAllFriends() {
        const body = types.GetAllFriendsRequest.encode(types.GetAllFriendsRequest.create({})).finish();
        const { body: replyBody } = await this.sendMsgAsync('gamepb.friendpb.FriendService', 'GetAll', body);
        return types.GetAllFriendsReply.decode(replyBody);
    }

    async enterFriendFarm(friendGid) {
        const body = types.VisitEnterRequest.encode(types.VisitEnterRequest.create({
            host_gid: toLong(friendGid), reason: 2,
        })).finish();
        const { body: replyBody } = await this.sendMsgAsync('gamepb.visitpb.VisitService', 'Enter', body);
        return types.VisitEnterReply.decode(replyBody);
    }

    async leaveFriendFarm(friendGid) {
        const body = types.VisitLeaveRequest.encode(types.VisitLeaveRequest.create({ host_gid: toLong(friendGid) })).finish();
        try { await this.sendMsgAsync('gamepb.visitpb.VisitService', 'Leave', body); } catch (e) { }
    }

    async helpWater(friendGid, landIds) {
        const body = types.WaterLandRequest.encode(types.WaterLandRequest.create({ land_ids: landIds, host_gid: toLong(friendGid) })).finish();
        const { body: replyBody } = await this.sendMsgAsync('gamepb.plantpb.PlantService', 'WaterLand', body);
        const reply = types.WaterLandReply.decode(replyBody);
        if (reply.operation_limits) this._updateOperationLimits(reply.operation_limits);
        return reply;
    }

    async helpWeed(friendGid, landIds) {
        const body = types.WeedOutRequest.encode(types.WeedOutRequest.create({ land_ids: landIds, host_gid: toLong(friendGid) })).finish();
        const { body: replyBody } = await this.sendMsgAsync('gamepb.plantpb.PlantService', 'WeedOut', body);
        const reply = types.WeedOutReply.decode(replyBody);
        if (reply.operation_limits) this._updateOperationLimits(reply.operation_limits);
        return reply;
    }

    async helpInsecticide(friendGid, landIds) {
        const body = types.InsecticideRequest.encode(types.InsecticideRequest.create({ land_ids: landIds, host_gid: toLong(friendGid) })).finish();
        const { body: replyBody } = await this.sendMsgAsync('gamepb.plantpb.PlantService', 'Insecticide', body);
        const reply = types.InsecticideReply.decode(replyBody);
        if (reply.operation_limits) this._updateOperationLimits(reply.operation_limits);
        return reply;
    }

    async stealHarvest(friendGid, landIds) {
        const body = types.HarvestRequest.encode(types.HarvestRequest.create({
            land_ids: landIds, host_gid: toLong(friendGid), is_all: true,
        })).finish();
        const { body: replyBody } = await this.sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body);
        const reply = types.HarvestReply.decode(replyBody);
        if (reply.operation_limits) this._updateOperationLimits(reply.operation_limits);
        return reply;
    }

    // ================================================================
    //  操作限制 (每日重置)
    // ================================================================

    _updateOperationLimits(limits) {
        if (!limits || limits.length === 0) return;
        this._checkDailyReset();
        for (const limit of limits) {
            const id = toNum(limit.id);
            if (id > 0) {
                const newExpTimes = toNum(limit.day_exp_times);
                this.operationLimits.set(id, {
                    dayTimes: toNum(limit.day_times),
                    dayTimesLimit: toNum(limit.day_times_lt),
                    dayExpTimes: newExpTimes,
                    dayExpTimesLimit: toNum(limit.day_ex_times_lt),
                });
                if (this.expTracker.has(id)) {
                    const prev = this.expTracker.get(id);
                    this.expTracker.delete(id);
                    if (newExpTimes <= prev && !this.expExhausted.has(id)) {
                        this.expExhausted.add(id);
                    }
                }
            }
        }
    }

    _checkDailyReset() {
        const d = new Date();
        const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (this.lastResetDate !== today) {
            this.operationLimits.clear();
            this.expExhausted.clear();
            this.expTracker.clear();
            this.lastResetDate = today;
        }
    }

    _canGetExp(opId) {
        if (this.expExhausted.has(opId)) return false;
        const limit = this.operationLimits.get(opId);
        if (!limit) return true;
        if (limit.dayExpTimesLimit > 0) return limit.dayExpTimes < limit.dayExpTimesLimit;
        return true;
    }

    _canOperate(opId) {
        const limit = this.operationLimits.get(opId);
        if (!limit) return true;
        if (limit.dayTimesLimit <= 0) return true;
        return limit.dayTimes < limit.dayTimesLimit;
    }

    _markExpCheck(opId) {
        const limit = this.operationLimits.get(opId);
        if (limit) this.expTracker.set(opId, limit.dayExpTimes);
    }

    // ================================================================
    //  好友巡查循环
    // ================================================================

    analyzeFriendLands(lands, myGid) {
        // 白萝卜植物ID列表
        const RADISH_PLANT_IDS = [2020002, 1020002];
        
        const result = { stealable: [], stealableInfo: [], needWater: [], needWeed: [], needBug: [] };
        for (const land of lands) {
            const id = toNum(land.id);
            const plant = land.plant;
            if (!plant || !plant.phases || plant.phases.length === 0) continue;
            const currentPhase = this.getCurrentPhase(plant.phases);
            if (!currentPhase) continue;
            const phaseVal = currentPhase.phase;
            if (phaseVal === PlantPhase.MATURE) {
                if (plant.stealable) {
                    const plantId = toNum(plant.id);
                    // 跳过白萝卜
                    if (this.featureToggles.skipStealRadish && RADISH_PLANT_IDS.includes(plantId)) {
                        continue;
                    }
                    result.stealable.push(id);
                    result.stealableInfo.push({ landId: id, plantId, name: getPlantName(plantId) || plant.name || '未知' });
                }
                continue;
            }
            if (phaseVal === PlantPhase.DEAD) continue;
            if (toNum(plant.dry_num) > 0) result.needWater.push(id);
            if (plant.weed_owners && plant.weed_owners.length > 0) result.needWeed.push(id);
            if (plant.insect_owners && plant.insect_owners.length > 0) result.needBug.push(id);
        }
        return result;
    }

    async visitFriend(friend, totalActions) {
        const { gid, name } = friend;
        let enterReply;
        try { enterReply = await this.enterFriendFarm(gid); }
        catch (e) { this.logWarn('好友', `进入 ${name} 农场失败: ${e.message}`); return; }

        const lands = enterReply.lands || [];
        if (lands.length === 0) { await this.leaveFriendFarm(gid); return; }

        const status = this.analyzeFriendLands(lands, this.userState.gid);
        const hasAnything = status.stealable.length + status.needWeed.length + status.needBug.length + status.needWater.length;
        if (hasAnything === 0) { await this.leaveFriendFarm(gid); return; }
        const actions = [];
        const skipped = [];

        // 帮除草
        if (status.needWeed.length > 0 && this.featureToggles.friendHelp) {
            if (this.featureToggles.helpEvenExpFull || this._canGetExp(10005)) {
                this._markExpCheck(10005);
                let ok = 0;
                for (const landId of status.needWeed) {
                    try { await this.helpWeed(gid, [landId]); ok++; } catch (e) { }
                    await sleep(100);
                }
                if (ok > 0) { actions.push(`🌿除草×${ok}`); totalActions.weed += ok; this.dailyStats.helpWeed += ok; }
            } else {
                skipped.push(`🌿草${status.needWeed.length}(经验已满)`);
            }
        }
        // 帮除虫
        if (status.needBug.length > 0 && this.featureToggles.friendHelp) {
            if (this.featureToggles.helpEvenExpFull || this._canGetExp(10006)) {
                this._markExpCheck(10006);
                let ok = 0;
                for (const landId of status.needBug) {
                    try { await this.helpInsecticide(gid, [landId]); ok++; } catch (e) { }
                    await sleep(100);
                }
                if (ok > 0) { actions.push(`🐛除虫×${ok}`); totalActions.bug += ok; this.dailyStats.helpPest += ok; }
            } else {
                skipped.push(`🐛虫${status.needBug.length}(经验已满)`);
            }
        }
        // 帮浇水
        if (status.needWater.length > 0 && this.featureToggles.friendHelp) {
            if (this.featureToggles.helpEvenExpFull || this._canGetExp(10007)) {
                this._markExpCheck(10007);
                let ok = 0;
                for (const landId of status.needWater) {
                    try { await this.helpWater(gid, [landId]); ok++; } catch (e) { }
                    await sleep(100);
                }
                if (ok > 0) { actions.push(`💦浇水×${ok}`); totalActions.water += ok; this.dailyStats.helpWater += ok; }
            } else {
                skipped.push(`💦水${status.needWater.length}(经验已满)`);
            }
        }
        // 偷菜
        if (status.stealable.length > 0 && this.featureToggles.autoSteal) {
            let ok = 0;
            const stolenPlants = [];
            for (let i = 0; i < status.stealable.length; i++) {
                try {
                    await this.stealHarvest(gid, [status.stealable[i]]);
                    ok++;
                    if (status.stealableInfo[i]) stolenPlants.push(status.stealableInfo[i].name);
                } catch (e) { }
                await sleep(100);
            }
            if (ok > 0) {
                const plantNames = [...new Set(stolenPlants)].join('/');
                actions.push(`🥬偷${ok}${plantNames ? '(' + plantNames + ')' : ''}`);
                totalActions.steal += ok;
                this._checkDailyReset();
                this.dailyStats.stealCount += ok;
            }
        }

        const allParts = [...actions];
        if (skipped.length > 0) allParts.push(`⚠️跳过: ${skipped.join(' / ')}`);
        if (allParts.length > 0) this.log('好友', `访问 ${name}: ${allParts.join(' | ')}`);
        await this.leaveFriendFarm(gid);
    }

    async checkFriends() {
        if (this.isCheckingFriends || !this.userState.gid) return;
        this.isCheckingFriends = true;
        this._checkDailyReset();
        try {
            const friendsReply = await this.getAllFriends();
            const friends = friendsReply.game_friends || [];
            if (friends.length === 0) return;

            // 智能预筛选：根据好友列表摘要数据跳过确定无事可做的好友
            const friendsToVisit = [];
            const visitedGids = new Set();

            let skippedCount = 0;
            for (const f of friends) {
                const gid = toNum(f.gid);
                if (gid === this.userState.gid || visitedGids.has(gid)) continue;
                const name = f.remark || f.name || `GID:${gid}`;
                const p = f.plant;
                const stealNum = p ? toNum(p.steal_plant_num) : 0;
                const dryNum = p ? toNum(p.dry_num) : 0;
                const weedNum = p ? toNum(p.weed_num) : 0;
                const insectNum = p ? toNum(p.insect_num) : 0;
                // 根据开关决定是否有事可做
                const canSteal = this.featureToggles.autoSteal && stealNum > 0;
                const canHelp = this.featureToggles.friendHelp && (dryNum > 0 || weedNum > 0 || insectNum > 0);
                // 有可偷 或 有可帮忙 → 访问
                if (canSteal || canHelp) {
                    friendsToVisit.push({ gid, name, level: toNum(f.level), stealNum, dryNum, weedNum, insectNum });
                    visitedGids.add(gid);
                } else {
                    skippedCount++;
                }
            }

            if (friendsToVisit.length === 0) {
                this.log('好友', `好友 ${friends.length} 人，全部无事可做`);
                return;
            }

            // 打印待访问列表摘要
            const visitSummary = friendsToVisit.map(f => {
                const parts = [];
                if (f.stealNum > 0) parts.push(`偷${f.stealNum}`);
                if (f.weedNum > 0) parts.push(`草${f.weedNum}`);
                if (f.insectNum > 0) parts.push(`虫${f.insectNum}`);
                if (f.dryNum > 0) parts.push(`水${f.dryNum}`);
                return `${f.name}(${parts.join('/')})`;
            }).join(', ');
            this.log('好友', `待访问 ${friendsToVisit.length}/${friends.length} 人 (跳过${skippedCount}人): ${visitSummary}`);

            const totalActions = { steal: 0, water: 0, weed: 0, bug: 0 };
            for (const friend of friendsToVisit) {
                try { await this.visitFriend(friend, totalActions); } catch (e) { }
                await sleep(500);
            }

            const summary = [];
            if (totalActions.steal > 0) summary.push(`🥬偷×${totalActions.steal}`);
            if (totalActions.weed > 0) summary.push(`🌿除草×${totalActions.weed}`);
            if (totalActions.bug > 0) summary.push(`🐛除虫×${totalActions.bug}`);
            if (totalActions.water > 0) summary.push(`💦浇水×${totalActions.water}`);
            if (summary.length > 0) {
                this.log('好友', `巡查完成 (${friendsToVisit.length}人) → ${summary.join(' | ')}`);
            } else {
                this.log('好友', `巡查完成 (${friendsToVisit.length}人)，无可操作`);
            }
        } catch (err) {
            this.logWarn('好友', `巡查失败: ${err.message}`);
        } finally {
            this.isCheckingFriends = false;
        }
    }

    async friendCheckLoop() {
        while (this.friendLoopRunning) {
            await this.checkFriends();
            if (!this.friendLoopRunning) break;
            await sleep(this.friendInterval);
        }
    }

    startFriendLoop() {
        if (this.friendLoopRunning) return;
        this.friendLoopRunning = true;
        this.friendCheckTimer = setTimeout(() => this.friendCheckLoop(), 5000);
    }

    // ================================================================
    //  任务系统
    // ================================================================

    async checkAndClaimTasks() {
        try {
            const body = types.TaskInfoRequest.encode(types.TaskInfoRequest.create({})).finish();
            const { body: replyBody } = await this.sendMsgAsync('gamepb.taskpb.TaskService', 'TaskInfo', body);
            const reply = types.TaskInfoReply.decode(replyBody);
            if (!reply.task_info) return;

            const allTasks = [
                ...(reply.task_info.growth_tasks || []),
                ...(reply.task_info.daily_tasks || []),
                ...(reply.task_info.tasks || []),
            ];
            const claimable = [];
            for (const task of allTasks) {
                const id = toNum(task.id);
                const progress = toNum(task.progress);
                const totalProgress = toNum(task.total_progress);
                if (task.is_unlocked && !task.is_claimed && progress >= totalProgress && totalProgress > 0) {
                    claimable.push({ id, desc: task.desc || `任务#${id}`, shareMultiple: toNum(task.share_multiple), rewards: task.rewards || [] });
                }
            }
            if (claimable.length === 0) return;
            this.log('任务', `发现 ${claimable.length} 个可领取任务`);

            for (const task of claimable) {
                try {
                    const useShare = task.shareMultiple > 1;
                    const claimBody = types.ClaimTaskRewardRequest.encode(types.ClaimTaskRewardRequest.create({ id: toLong(task.id), do_shared: useShare })).finish();
                    const { body: claimReplyBody } = await this.sendMsgAsync('gamepb.taskpb.TaskService', 'ClaimTaskReward', claimBody);
                    const claimReply = types.ClaimTaskRewardReply.decode(claimReplyBody);
                    const items = claimReply.items || [];
                    const rewardParts = items.map(item => {
                        const id = toNum(item.id);
                        const count = toNum(item.count);
                        if (id === 1) return `💰金币+${count}`;
                        if (id === 2) return `⭐经验+${count}`;
                        return `${getItemName(id)} ×${count}`;
                    });
                    this.log('任务', `✅ 领取成功: ${task.desc} → ${rewardParts.join(' | ') || '无奖励'}`);
                    await sleep(300);
                } catch (e) { this.logWarn('任务', `领取失败 #${task.id}: ${e.message}`); }
            }
        } catch (e) { /* 静默 */ }
    }

    _handleTaskNotify(taskInfo) {
        const allTasks = [...(taskInfo.growth_tasks || []), ...(taskInfo.daily_tasks || []), ...(taskInfo.tasks || [])];
        const hasClaimable = allTasks.some(t => t.is_unlocked && !t.is_claimed && toNum(t.progress) >= toNum(t.total_progress) && toNum(t.total_progress) > 0);
        if (hasClaimable) {
            setTimeout(() => this.checkAndClaimTasks(), 1000);
        }
    }

    _initTaskSystem() {
        setTimeout(() => this.checkAndClaimTasks(), 4000);
        // 启动每日奖励系统
        this._initDailyRewardSystem();
    }

    // ================================================================
    //  每日奖励系统 (8个新功能)
    // ================================================================

    _getDateKey() {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    _isDoneToday(key) {
        return this.dailyRewardState[key] === this._getDateKey();
    }

    _markDoneToday(key) {
        this.dailyRewardState[key] = this._getDateKey();
    }

    _getRewardSummary(items) {
        if (!items || items.length === 0) return '无奖励';
        const parts = [];
        for (const item of items) {
            const id = toNum(item.id);
            const count = toNum(item.count);
            if (count <= 0) continue;
            if (id === 1 || id === 1001) parts.push(`💰金币+${count}`);
            else if (id === 2 || id === 1101) parts.push(`⭐经验+${count}`);
            else if (id === 1002) parts.push(`💎点券+${count}`);
            else parts.push(`${getItemName(id)}×${count}`);
        }
        return parts.join(' | ') || '无奖励';
    }

    _initDailyRewardSystem() {
        // 首次执行延迟 8 秒
        setTimeout(() => this._runDailyRewards(), 8000);
        // 每小时检查一次
        this.dailyRoutineTimer = setInterval(() => this._runDailyRewards(), 60 * 60 * 1000);
    }

    async _runDailyRewards() {
        if (this.status !== 'running') return;
        const toggles = this.featureToggles;
        
        try {
            if (toggles.autoFreeGifts) await this._claimFreeGifts();
            await sleep(500);
            if (toggles.autoShareReward) await this._claimShareReward();
            await sleep(500);
            if (toggles.autoMonthCard) await this._claimMonthCard();
            await sleep(500);
            if (toggles.autoEmailReward) await this._claimEmailRewards();
            await sleep(500);
            if (toggles.autoVipGift) await this._claimVipGift();
            await sleep(500);
            if (toggles.autoIllustrated) await this._claimIllustratedRewards();
            await sleep(500);
            if (toggles.autoFertilizerUse) await this._useFertilizerGiftPacks();
            await sleep(500);
            if (toggles.autoFertilizerBuy) await this._buyOrganicFertilizer();
        } catch (e) {
            this.logWarn('奖励', `每日奖励检查出错: ${e.message}`);
        }
    }

    // --- 1. 商城免费礼包 ---
    async _claimFreeGifts(force = false) {
        if (!force && this._isDoneToday('freeGifts')) return 0;
        
        try {
            // 获取商城列表 (slot_type=1 为普通商城)
            const reqBody = types.GetMallListBySlotTypeRequest.encode(
                types.GetMallListBySlotTypeRequest.create({ slot_type: 1 })
            ).finish();
            const { body: replyBody } = await this.sendMsgAsync(
                'gamepb.mallpb.MallService', 'GetMallListBySlotType', reqBody
            );
            const reply = types.GetMallListBySlotTypeResponse.decode(replyBody);
            const goodsList = reply.goods_list || [];

            let claimed = 0;
            for (const goodsBytes of goodsList) {
                try {
                    const goods = types.MallGoods.decode(goodsBytes);
                    if (goods.is_free && goods.goods_id > 0) {
                        const purchaseReq = types.PurchaseRequest.encode(
                            types.PurchaseRequest.create({ goods_id: goods.goods_id, count: 1 })
                        ).finish();
                        await this.sendMsgAsync('gamepb.mallpb.MallService', 'Purchase', purchaseReq);
                        claimed++;
                        await sleep(200);
                    }
                } catch (e) { /* 单个商品解析失败，继续 */ }
            }

            if (claimed > 0) {
                this.log('商城', `🎁 领取免费礼包 ×${claimed}`);
            }
            this._markDoneToday('freeGifts');
            return claimed;
        } catch (e) {
            if (!e.message.includes('已领取')) {
                this.logWarn('商城', `免费礼包领取失败: ${e.message}`);
            }
            this._markDoneToday('freeGifts');
            return 0;
        }
    }

    // --- 2. 分享奖励 ---
    async _claimShareReward(force = false) {
        if (!force && this._isDoneToday('share')) return false;

        try {
            // 检查是否可分享
            const checkReq = types.CheckCanShareRequest.encode(
                types.CheckCanShareRequest.create({})
            ).finish();
            const { body: checkBody } = await this.sendMsgAsync(
                'gamepb.sharepb.ShareService', 'CheckCanShare', checkReq
            );
            const checkReply = types.CheckCanShareReply.decode(checkBody);
            
            if (!checkReply.can_share) {
                this._markDoneToday('share');
                return false;
            }

            // 上报分享
            const reportReq = types.ReportShareRequest.encode(
                types.ReportShareRequest.create({ shared: true })
            ).finish();
            await this.sendMsgAsync('gamepb.sharepb.ShareService', 'ReportShare', reportReq);
            await sleep(300);

            // 领取奖励
            const claimReq = types.ClaimShareRewardRequest.encode(
                types.ClaimShareRewardRequest.create({ claimed: true })
            ).finish();
            const { body: claimBody } = await this.sendMsgAsync(
                'gamepb.sharepb.ShareService', 'ClaimShareReward', claimReq
            );
            const claimReply = types.ClaimShareRewardReply.decode(claimBody);

            if (claimReply.success || claimReply.items?.length > 0) {
                this.log('分享', `📤 分享奖励已领取: ${this._getRewardSummary(claimReply.items)}`);
                this._markDoneToday('share');
                return true;
            }
            this._markDoneToday('share');
            return false;
        } catch (e) {
            if (e.message.includes('已领取') || e.message.includes('已分享')) {
                this._markDoneToday('share');
            }
            return false;
        }
    }

    // --- 3. 月卡奖励 ---
    async _claimMonthCard(force = false) {
        if (!force && this._isDoneToday('monthCard')) return false;

        try {
            // 获取月卡信息
            const infoReq = types.GetMonthCardInfosRequest.encode(
                types.GetMonthCardInfosRequest.create({})
            ).finish();
            const { body: infoBody } = await this.sendMsgAsync(
                'gamepb.mallpb.MallService', 'GetMonthCardInfos', infoReq
            );
            const infoReply = types.GetMonthCardInfosReply.decode(infoBody);
            const infos = infoReply.infos || [];

            // 筛选可领取的月卡
            const claimable = infos.filter(x => x.can_claim && x.goods_id > 0);
            if (claimable.length === 0) {
                this._markDoneToday('monthCard');
                return false;
            }

            let claimed = 0;
            for (const info of claimable) {
                try {
                    const claimReq = types.ClaimMonthCardRewardRequest.encode(
                        types.ClaimMonthCardRewardRequest.create({ goods_id: info.goods_id })
                    ).finish();
                    const { body: claimBody } = await this.sendMsgAsync(
                        'gamepb.mallpb.MallService', 'ClaimMonthCardReward', claimReq
                    );
                    const claimReply = types.ClaimMonthCardRewardReply.decode(claimBody);
                    this.log('月卡', `📅 月卡奖励已领取: ${this._getRewardSummary(claimReply.items)}`);
                    claimed++;
                    await sleep(300);
                } catch (e) { /* 单个月卡领取失败 */ }
            }

            this._markDoneToday('monthCard');
            return claimed > 0;
        } catch (e) {
            this._markDoneToday('monthCard');
            return false;
        }
    }

    // --- 4. 邮箱奖励 ---
    async _claimEmailRewards(force = false) {
        if (!force && this._isDoneToday('email')) return { claimed: 0 };

        try {
            // 获取两个邮箱的邮件
            const emails = [];
            for (const boxType of [1, 2]) {
                try {
                    const req = types.GetEmailListRequest.encode(
                        types.GetEmailListRequest.create({ box_type: boxType })
                    ).finish();
                    const { body: replyBody } = await this.sendMsgAsync(
                        'gamepb.emailpb.EmailService', 'GetEmailList', req
                    );
                    const reply = types.GetEmailListReply.decode(replyBody);
                    for (const email of (reply.emails || [])) {
                        if (email.has_reward && !email.claimed) {
                            emails.push({ ...email, boxType });
                        }
                    }
                } catch (e) { /* 单个邮箱获取失败 */ }
            }

            if (emails.length === 0) {
                this._markDoneToday('email');
                return { claimed: 0 };
            }

            let claimed = 0;
            let totalRewards = [];

            // 尝试批量领取，失败则单个领取
            for (const email of emails) {
                try {
                    // 先尝试批量领取
                    const batchReq = types.BatchClaimEmailRequest.encode(
                        types.BatchClaimEmailRequest.create({ box_type: email.boxType, email_id: email.id })
                    ).finish();
                    const { body: batchBody } = await this.sendMsgAsync(
                        'gamepb.emailpb.EmailService', 'BatchClaimEmail', batchReq
                    );
                    const batchReply = types.BatchClaimEmailReply.decode(batchBody);
                    if (batchReply.items) totalRewards.push(...batchReply.items);
                    claimed++;
                } catch (e) {
                    // 批量失败，尝试单个领取
                    try {
                        const singleReq = types.ClaimEmailRequest.encode(
                            types.ClaimEmailRequest.create({ box_type: email.boxType, email_id: email.id })
                        ).finish();
                        const { body: singleBody } = await this.sendMsgAsync(
                            'gamepb.emailpb.EmailService', 'ClaimEmail', singleReq
                        );
                        const singleReply = types.ClaimEmailReply.decode(singleBody);
                        if (singleReply.items) totalRewards.push(...singleReply.items);
                        claimed++;
                    } catch (e2) { /* 单个也失败 */ }
                }
                await sleep(100);
            }

            if (claimed > 0) {
                this.log('邮箱', `📧 领取邮件奖励 ×${claimed}: ${this._getRewardSummary(totalRewards)}`);
            }
            this._markDoneToday('email');
            return { claimed };
        } catch (e) {
            this._markDoneToday('email');
            return { claimed: 0 };
        }
    }

    // --- 5. QQ会员奖励 ---
    async _claimVipGift(force = false) {
        if (!force && this._isDoneToday('vipGift')) return false;

        try {
            // 获取会员礼包状态
            const statusReq = types.GetDailyGiftStatusRequest.encode(
                types.GetDailyGiftStatusRequest.create({})
            ).finish();
            const { body: statusBody } = await this.sendMsgAsync(
                'gamepb.qqvippb.QQVipService', 'GetDailyGiftStatus', statusReq
            );
            const statusReply = types.GetDailyGiftStatusReply.decode(statusBody);

            if (!statusReply.can_claim) {
                this._markDoneToday('vipGift');
                return false;
            }

            // 领取礼包
            const claimReq = types.ClaimDailyGiftRequest.encode(
                types.ClaimDailyGiftRequest.create({})
            ).finish();
            const { body: claimBody } = await this.sendMsgAsync(
                'gamepb.qqvippb.QQVipService', 'ClaimDailyGift', claimReq
            );
            const claimReply = types.ClaimDailyGiftReply.decode(claimBody);

            if (claimReply.items?.length > 0) {
                this.log('会员', `👑 QQ会员奖励已领取: ${this._getRewardSummary(claimReply.items)}`);
                this._markDoneToday('vipGift');
                return true;
            }
            this._markDoneToday('vipGift');
            return false;
        } catch (e) {
            // 已领取错误码处理
            if (e.message.includes('1021002') || e.message.includes('已领取')) {
                this._markDoneToday('vipGift');
            }
            return false;
        }
    }

    // --- 6. 点券购买化肥 ---
    async _buyOrganicFertilizer(force = false) {
        const COOLDOWN_MS = 10 * 60 * 1000; // 10分钟冷却
        const now = Date.now();
        
        if (!force && now - this.lastFertilizerBuyAt < COOLDOWN_MS) return 0;
        if (!force && this._isDoneToday('fertilizerBuy')) return 0;

        try {
            // 获取商城列表
            const reqBody = types.GetMallListBySlotTypeRequest.encode(
                types.GetMallListBySlotTypeRequest.create({ slot_type: 1 })
            ).finish();
            const { body: replyBody } = await this.sendMsgAsync(
                'gamepb.mallpb.MallService', 'GetMallListBySlotType', reqBody
            );
            const reply = types.GetMallListBySlotTypeResponse.decode(replyBody);
            const goodsList = reply.goods_list || [];

            // 查找有机化肥商品 (goods_id = 1002)
            let fertilizerGoods = null;
            for (const goodsBytes of goodsList) {
                try {
                    const goods = types.MallGoods.decode(goodsBytes);
                    if (goods.goods_id === 1002) {
                        fertilizerGoods = goods;
                        break;
                    }
                } catch (e) { /* 解析失败 */ }
            }

            if (!fertilizerGoods) {
                this._markDoneToday('fertilizerBuy');
                return 0;
            }

            let totalBought = 0;
            const MAX_ROUNDS = 100;
            const BUY_PER_ROUND = 10;

            for (let i = 0; i < MAX_ROUNDS; i++) {
                try {
                    const purchaseReq = types.PurchaseRequest.encode(
                        types.PurchaseRequest.create({ goods_id: fertilizerGoods.goods_id, count: BUY_PER_ROUND })
                    ).finish();
                    await this.sendMsgAsync('gamepb.mallpb.MallService', 'Purchase', purchaseReq);
                    totalBought += BUY_PER_ROUND;
                    await sleep(100);
                } catch (e) {
                    // 余额不足或其他错误
                    if (e.message.includes('余额不足') || e.message.includes('点券不足') || 
                        e.message.includes('1000019') || e.message.includes('不足')) {
                        break;
                    }
                    break;
                }
            }

            if (totalBought > 0) {
                this.log('商城', `🧪 点券购买有机化肥 ×${totalBought}`);
                this.lastFertilizerBuyAt = now;
            }
            
            return totalBought;
        } catch (e) {
            return 0;
        }
    }

    // --- 7. 自动使用化肥礼包 ---
    async _useFertilizerGiftPacks(force = false) {
        if (!force && this._isDoneToday('fertilizerUse')) return 0;

        const FERTILIZER_GIFT_IDS = new Set([100003, 100004]); // 化肥礼包ID
        const FERTILIZER_ITEM_IDS = new Map([
            [80001, { type: 'normal', hours: 1 }],
            [80002, { type: 'normal', hours: 4 }],
            [80003, { type: 'normal', hours: 8 }],
            [80004, { type: 'normal', hours: 12 }],
            [80011, { type: 'organic', hours: 1 }],
            [80012, { type: 'organic', hours: 4 }],
            [80013, { type: 'organic', hours: 8 }],
            [80014, { type: 'organic', hours: 12 }],
        ]);
        const CONTAINER_LIMIT_HOURS = 990;
        const NORMAL_CONTAINER_ID = 1011;
        const ORGANIC_CONTAINER_ID = 1012;

        try {
            const bagReply = await this._getBag();
            const items = this._getBagItems(bagReply);

            // 获取当前容器时长
            let normalSec = 0, organicSec = 0;
            for (const it of items) {
                const id = toNum(it.id);
                const count = toNum(it.count);
                if (id === NORMAL_CONTAINER_ID) normalSec = count;
                if (id === ORGANIC_CONTAINER_ID) organicSec = count;
            }
            const containerHours = {
                normal: normalSec / 3600,
                organic: organicSec / 3600,
            };

            // 收集可使用的化肥道具
            const toUse = [];
            for (const it of items) {
                const id = toNum(it.id);
                const count = toNum(it.count);
                if (count <= 0) continue;
                
                // 1. 先使用化肥礼包
                if (FERTILIZER_GIFT_IDS.has(id)) {
                    toUse.push({ id, count, isGift: true });
                }
                // 2. 使用化肥道具
                else if (FERTILIZER_ITEM_IDS.has(id)) {
                    const info = FERTILIZER_ITEM_IDS.get(id);
                    const currentHours = info.type === 'normal' ? containerHours.normal : containerHours.organic;
                    if (currentHours < CONTAINER_LIMIT_HOURS) {
                        const remainHours = CONTAINER_LIMIT_HOURS - currentHours;
                        const maxCount = Math.floor(remainHours / info.hours);
                        const useCount = Math.min(count, maxCount);
                        if (useCount > 0) {
                            toUse.push({ id, count: useCount, isGift: false, type: info.type, hours: info.hours });
                        }
                    }
                }
            }

            if (toUse.length === 0) {
                this._markDoneToday('fertilizerUse');
                return 0;
            }

            let used = 0;
            for (const item of toUse) {
                try {
                    // 尝试批量使用
                    const batchReq = types.BatchUseRequest.encode(
                        types.BatchUseRequest.create({
                            items: [{ item_id: toLong(item.id), count: toLong(item.count) }]
                        })
                    ).finish();
                    await this.sendMsgAsync('gamepb.itempb.ItemService', 'BatchUse', batchReq);
                    used += item.count;
                    
                    // 更新容器计数
                    if (!item.isGift && item.type && item.hours) {
                        if (item.type === 'normal') containerHours.normal += item.count * item.hours;
                        else containerHours.organic += item.count * item.hours;
                    }
                } catch (e) {
                    // 批量失败，尝试单个使用
                    try {
                        const singleReq = types.UseRequest.encode(
                            types.UseRequest.create({ item_id: toLong(item.id), count: toLong(item.count) })
                        ).finish();
                        await this.sendMsgAsync('gamepb.itempb.ItemService', 'Use', singleReq);
                        used += item.count;
                    } catch (e2) {
                        // 容器已满
                        if (e2.message.includes('1003002') || e2.message.includes('上限')) {
                            continue;
                        }
                    }
                }
                await sleep(100);
            }

            if (used > 0) {
                this.log('仓库', `🧴 使用化肥道具 ×${used}`);
            }
            this._markDoneToday('fertilizerUse');
            return used;
        } catch (e) {
            this._markDoneToday('fertilizerUse');
            return 0;
        }
    }

    // --- 8. 图鉴奖励 ---
    async _claimIllustratedRewards(force = false) {
        if (!force && this._isDoneToday('illustrated')) return false;

        try {
            // 领取所有可领取的图鉴奖励
            const claimReq = types.ClaimAllRewardsV2Request.encode(
                types.ClaimAllRewardsV2Request.create({ only_claimable: true })
            ).finish();
            const { body: claimBody } = await this.sendMsgAsync(
                'gamepb.illustratedpb.IllustratedService', 'ClaimAllRewardsV2', claimReq
            );
            const claimReply = types.ClaimAllRewardsV2Reply.decode(claimBody);

            const allItems = [...(claimReply.items || []), ...(claimReply.bonus_items || [])];
            if (allItems.length > 0) {
                this.log('图鉴', `📖 图鉴奖励已领取: ${this._getRewardSummary(allItems)}`);
                this._markDoneToday('illustrated');
                return true;
            }
            this._markDoneToday('illustrated');
            return false;
        } catch (e) {
            this._markDoneToday('illustrated');
            return false;
        }
    }

    // ================================================================
    //  好友申请
    // ================================================================

    async _handleFriendApplications(applications) {
        const names = applications.map(a => a.name || `GID:${toNum(a.gid)}`).join(', ');
        this.log('申请', `收到 ${applications.length} 个好友申请: ${names}`);
        const gids = applications.map(a => toNum(a.gid));
        try {
            const body = types.AcceptFriendsRequest.encode(types.AcceptFriendsRequest.create({
                friend_gids: gids.map(g => toLong(g)),
            })).finish();
            const { body: replyBody } = await this.sendMsgAsync('gamepb.friendpb.FriendService', 'AcceptFriends', body);
            const reply = types.AcceptFriendsReply.decode(replyBody);
            const friends = reply.friends || [];
            if (friends.length > 0) {
                this.log('申请', `已同意 ${friends.length} 人`);
            }
        } catch (e) { this.logWarn('申请', `同意失败: ${e.message}`); }
    }

    // ================================================================
    //  仓库 - 自动出售果实
    // ================================================================

    async _getBag() {
        const body = types.BagRequest.encode(types.BagRequest.create({})).finish();
        const { body: replyBody } = await this.sendMsgAsync('gamepb.itempb.ItemService', 'Bag', body);
        return types.BagReply.decode(replyBody);
    }

    _getBagItems(bagReply) {
        if (bagReply.item_bag && bagReply.item_bag.items && bagReply.item_bag.items.length) return bagReply.item_bag.items;
        return bagReply.items || [];
    }

    async _sellItems(items) {
        const payload = items.map(item => ({
            id: item.id != null ? toLong(item.id) : undefined,
            count: item.count != null ? toLong(item.count) : undefined,
            uid: item.uid != null ? toLong(item.uid) : undefined,
        }));
        const body = types.SellRequest.encode(types.SellRequest.create({ items: payload })).finish();
        const { body: replyBody } = await this.sendMsgAsync('gamepb.itempb.ItemService', 'Sell', body);
        return types.SellReply.decode(replyBody);
    }

    _extractGold(sellReply) {
        if (sellReply.get_items && sellReply.get_items.length > 0) {
            for (const item of sellReply.get_items) {
                if (toNum(item.id) === GOLD_ITEM_ID) return toNum(item.count);
            }
            return 0;
        }
        return sellReply.gold !== undefined ? toNum(sellReply.gold) : 0;
    }

    async sellAllFruits() {
        try {
            const bagReply = await this._getBag();
            const items = this._getBagItems(bagReply);
            const toSell = [];
            const names = [];
            for (const item of items) {
                const id = toNum(item.id);
                const count = toNum(item.count);
                const uid = item.uid ? toNum(item.uid) : 0;
                if (isFruitId(id) && count > 0 && uid !== 0) {
                    toSell.push(item);
                    names.push(`${getFruitName(id)}x${count}`);
                }
            }
            if (toSell.length === 0) { return; }
            const reply = await this._sellItems(toSell);
            const totalGold = this._extractGold(reply);
            this._checkDailyReset();
            this.dailyStats.sellGold += totalGold;
            this.log('仓库', `出售果实: ${names.join(', ')} | 获得 💰${totalGold} 金币`);
        } catch (e) { this.logWarn('仓库', `出售失败: ${e.message}`); }
    }

    async _debugSellFruits() {
        try {
            const bagReply = await this._getBag();
            const items = this._getBagItems(bagReply);
            const toSell = items.filter(item => isFruitId(toNum(item.id)) && toNum(item.count) > 0);
            if (toSell.length === 0) return;
            const reply = await this._sellItems(toSell);
            const totalGold = this._extractGold(reply);
            this.log('仓库', `初始出售完成 | 获得 💰${totalGold} 金币`);
        } catch (e) { /* 静默 */ }
    }

    _startSellLoop(interval = 60000) {
        if (this.sellTimer) return;
        setTimeout(() => {
            this.sellAllFruits();
            this.sellTimer = setInterval(() => this.sellAllFruits(), interval);
        }, 10000);
    }

    // ================================================================
    //  生命周期
    // ================================================================

    /**
     * 启动 Bot (传入登录 code)
     * @param {string} code - QQ/微信登录凭证
     */
    async start(code) {
        if (this.status === 'running') {
            throw new Error('Bot 已在运行中');
        }
        this.errorMessage = '';
        this.log('系统', `🚀 Bot 正在启动... | 平台: ${this.platform} | 账号: ${this.userId}`);
        try {
            await this.connect(code);
        } catch (err) {
            this._setStatus('error');
            this.errorMessage = err.message;
            throw err;
        }
    }

    /**
     * 停止 Bot
     */
    stop() {
        this.log('系统', '⏸️ Bot 正在停止...');
        this.farmLoopRunning = false;
        this.friendLoopRunning = false;
        if (this.farmCheckTimer) { clearTimeout(this.farmCheckTimer); this.farmCheckTimer = null; }
        if (this.friendCheckTimer) { clearTimeout(this.friendCheckTimer); this.friendCheckTimer = null; }
        this._cleanup();
        if (this.ws) {
            try { this.ws.close(); } catch (e) { }
            this.ws = null;
        }
        if (this.status !== 'error') this._setStatus('stopped');
        this.log('系统', '⏹️ Bot 已停止');
    }

    _cleanup() {
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
        if (this.sellTimer) { clearInterval(this.sellTimer); this.sellTimer = null; }
        this.pendingCallbacks.forEach((cb) => { try { cb(new Error('Bot 已停止')); } catch (e) { } });
        this.pendingCallbacks.clear();
    }

    _setStatus(newStatus) {
        const old = this.status;
        this.status = newStatus;
        if (old !== newStatus) {
            this.emit('statusChange', { userId: this.userId, oldStatus: old, newStatus, userState: this.userState });
        }
    }

    _emitStateUpdate() {
        this.emit('stateUpdate', {
            userId: this.userId,
            status: this.status,
            userState: { ...this.userState },
            startedAt: this.startedAt,
        });
    }

    /**
     * 获取当前快照 (供 REST API 返回)
     */
    getSnapshot() {
        return {
            userId: this.userId,
            status: this.status,
            errorMessage: this.errorMessage,
            platform: this.platform,
            userState: { ...this.userState },
            farmInterval: this.farmInterval,
            friendInterval: this.friendInterval,
            startedAt: this.startedAt,
            uptime: this.startedAt ? Date.now() - this.startedAt : 0,
            featureToggles: { ...this.featureToggles },
            dailyStats: { ...this.dailyStats },
            preferredSeedId: this.preferredSeedId,
        };
    }

    /** 获取详细的土地状态 (含分析结果) */
    async getDetailedLandStatus() {
        try {
            const landsReply = await this.getAllLands();
            if (!landsReply.lands) return null;
            const lands = landsReply.lands;
            this._cachedLands = lands;
            this._cachedLandsTime = Date.now();

            const analysis = this.analyzeLands(lands);
            const totalLands = lands.length;
            const unlockedCount = lands.filter(l => l && l.unlocked).length;
            const lockedCount = totalLands - unlockedCount;

            // 构建每块地的详细信息
            const landDetails = [];
            for (const land of lands) {
                const id = toNum(land.id);
                const unlocked = !!land.unlocked;
                const detail = { id, unlocked, soilType: toNum(land.soil_type) || 0 };
                if (!unlocked) { landDetails.push(detail); continue; }

                const plant = land.plant;
                if (!plant || !plant.phases || plant.phases.length === 0) {
                    detail.status = 'empty';
                    landDetails.push(detail);
                    continue;
                }

                const currentPhase = this.getCurrentPhase(plant.phases);
                const phaseVal = currentPhase ? currentPhase.phase : 0;
                const plantId = toNum(plant.id);
                const plantName = getPlantName(plantId) || plant.name || '未知';

                detail.plantId = plantId;
                detail.plantName = plantName;
                detail.phase = phaseVal;
                detail.phaseName = PHASE_NAMES[phaseVal] || '未知';

                if (phaseVal === PlantPhase.DEAD) {
                    detail.status = 'dead';
                } else if (phaseVal === PlantPhase.MATURE) {
                    detail.status = 'harvestable';
                } else {
                    detail.status = 'growing';
                    // 计算剩余时间
                    const maturePhase = plant.phases.find(p => p.phase === PlantPhase.MATURE);
                    if (maturePhase) {
                        const nowSec = this.getServerTimeSec();
                        const matureBegin = this.toTimeSec(maturePhase.begin_time);
                        if (matureBegin > nowSec) {
                            detail.timeLeftSec = matureBegin - nowSec;
                        }
                    }
                }

                // 需要处理项
                detail.needWater = analysis.needWater.includes(id);
                detail.needWeed = analysis.needWeed.includes(id);
                detail.needBug = analysis.needBug.includes(id);
                landDetails.push(detail);
            }

            return {
                totalLands, unlockedCount, lockedCount,
                harvestable: analysis.harvestable.length,
                growing: analysis.growing.length,
                empty: analysis.empty.length,
                dead: analysis.dead.length,
                needAttention: analysis.needWater.length + analysis.needWeed.length + analysis.needBug.length,
                lands: landDetails,
                updatedAt: Date.now(),
            };
        } catch (err) {
            this.logWarn('API', `获取土地状态失败: ${err.message}`);
            return null;
        }
    }

    /** 更新功能开关 */
    setFeatureToggles(toggles) {
        Object.assign(this.featureToggles, toggles);
        this.log('配置', `功能开关已更新: ${JSON.stringify(toggles)}`);
    }

    /** 设置指定种植作物 */
    setPreferredSeedId(seedId) {
        this.preferredSeedId = seedId || 0;
        const name = seedId ? (getPlantNameBySeedId(seedId) || seedId) : '自动选择';
        this.log('配置', `种植作物已设置: ${name}`);
    }

    /** 重置每日统计 (每日凌晨自动调用) */
    _checkDailyReset() {
        const today = new Date().toLocaleDateString();
        if (this.dailyStats.date !== today) {
            this.dailyStats = {
                date: today,
                expGained: 0, harvestCount: 0, stealCount: 0,
                helpWater: 0, helpWeed: 0, helpPest: 0, sellGold: 0,
            };
        }
    }

    /**
     * 销毁实例 (释放所有资源)
     */
    destroy() {
        this.stop();
        this.removeAllListeners();
    }
}

module.exports = { BotInstance };
