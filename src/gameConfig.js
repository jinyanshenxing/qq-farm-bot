/**
 * 游戏配置数据模块
 * 从 gameConfig 目录加载配置数据
 */

const fs = require('fs');
const path = require('path');

// ============ 等级经验表 ============
let roleLevelConfig = null;
let levelExpTable = null;  // 累计经验表，索引为等级

// ============ 植物配置 ============
let plantConfig = null;
let plantMap = new Map();  // id -> plant
let seedToPlant = new Map();  // seed_id -> plant
let fruitToPlant = new Map();  // fruit_id -> plant (果实ID -> 植物)
let itemInfoConfig = null;
let itemInfoMap = new Map(); // item_id -> item config

/**
 * 加载配置文件
 */
function loadConfigs() {
    const configDir = path.join(__dirname, '..', 'gameConfig');
    
    // 加载等级经验配置
    try {
        const roleLevelPath = path.join(configDir, 'RoleLevel.json');
        if (fs.existsSync(roleLevelPath)) {
            roleLevelConfig = JSON.parse(fs.readFileSync(roleLevelPath, 'utf8'));
            // 构建累计经验表
            levelExpTable = [];
            for (const item of roleLevelConfig) {
                levelExpTable[item.level] = item.exp;
            }
            console.log(`[配置] 已加载等级经验表 (${roleLevelConfig.length} 级)`);
        }
    } catch (e) {
        console.warn('[配置] 加载 RoleLevel.json 失败:', e.message);
    }
    
    // 加载植物配置
    try {
        const plantPath = path.join(configDir, 'Plant.json');
        if (fs.existsSync(plantPath)) {
            plantConfig = JSON.parse(fs.readFileSync(plantPath, 'utf8'));
            plantMap.clear();
            seedToPlant.clear();
            fruitToPlant.clear();
            for (const plant of plantConfig) {
                plantMap.set(plant.id, plant);
                if (plant.seed_id) {
                    seedToPlant.set(plant.seed_id, plant);
                }
                if (plant.fruit && plant.fruit.id) {
                    fruitToPlant.set(plant.fruit.id, plant);
                }
            }
            console.log(`[配置] 已加载植物配置 (${plantConfig.length} 种)`);
        }
    } catch (e) {
        console.warn('[配置] 加载 Plant.json 失败:', e.message);
    }

    // 加载物品配置
    try {
        const itemInfoPath = path.join(configDir, 'ItemInfo.json');
        itemInfoConfig = null;
        itemInfoMap.clear();
        if (fs.existsSync(itemInfoPath)) {
            itemInfoConfig = JSON.parse(fs.readFileSync(itemInfoPath, 'utf8'));
            for (const item of itemInfoConfig) {
                const id = Number(item.id) || 0;
                if (id > 0) itemInfoMap.set(id, item);
            }
            console.log(`[配置] 已加载物品配置 (${itemInfoMap.size} 条)`);
        }
    } catch (e) {
        console.warn('[配置] 加载 ItemInfo.json 失败:', e.message);
    }
}

// ============ 等级经验相关 ============

/**
 * 获取等级经验表
 */
function getLevelExpTable() {
    return levelExpTable;
}

/**
 * 计算当前等级的经验进度
 * @param {number} level - 当前等级
 * @param {number} totalExp - 累计总经验
 * @returns {{ current: number, needed: number }} 当前等级经验进度
 */
function getLevelExpProgress(level, totalExp) {
    if (!levelExpTable || level <= 0) return { current: 0, needed: 0 };
    
    const currentLevelStart = levelExpTable[level] || 0;
    const nextLevelStart = levelExpTable[level + 1] || (currentLevelStart + 100000);
    
    const currentExp = Math.max(0, totalExp - currentLevelStart);
    const neededExp = nextLevelStart - currentLevelStart;
    
    return { current: currentExp, needed: neededExp };
}

// ============ 植物配置相关 ============

/**
 * 根据植物ID获取植物信息
 * @param {number} plantId - 植物ID
 */
function getPlantById(plantId) {
    return plantMap.get(plantId);
}

/**
 * 根据种子ID获取植物信息
 * @param {number} seedId - 种子ID
 */
function getPlantBySeedId(seedId) {
    return seedToPlant.get(seedId);
}

/**
 * 获取植物名称
 * @param {number} plantId - 植物ID
 */
function getPlantName(plantId) {
    const plant = plantMap.get(plantId);
    return plant ? plant.name : `植物${plantId}`;
}

/**
 * 根据种子ID获取植物名称
 * @param {number} seedId - 种子ID
 */
function getPlantNameBySeedId(seedId) {
    const plant = seedToPlant.get(seedId);
    return plant ? plant.name : `种子${seedId}`;
}

/**
 * 获取植物的果实信息
 * @param {number} plantId - 植物ID
 * @returns {{ id: number, count: number, name: string } | null}
 */
function getPlantFruit(plantId) {
    const plant = plantMap.get(plantId);
    if (!plant || !plant.fruit) return null;
    return {
        id: plant.fruit.id,
        count: plant.fruit.count,
        name: plant.name,
    };
}

/**
 * 获取植物的生长时间（秒）
 * @param {number} plantId - 植物ID
 */
function getPlantGrowTime(plantId) {
    const plant = plantMap.get(plantId);
    if (!plant || !plant.grow_phases) return 0;
    
    // 解析 "种子:30;发芽:30;成熟:0;" 格式
    const phases = plant.grow_phases.split(';').filter(p => p);
    let totalSeconds = 0;
    for (const phase of phases) {
        const match = phase.match(/:(\d+)/);
        if (match) {
            totalSeconds += parseInt(match[1]);
        }
    }
    return totalSeconds;
}

/**
 * 格式化时间
 * @param {number} seconds - 秒数
 */
function formatGrowTime(seconds) {
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return mins > 0 ? `${hours}小时${mins}分` : `${hours}小时`;
}

/**
 * 获取植物的收获经验
 * @param {number} plantId - 植物ID
 */
function getPlantExp(plantId) {
    const plant = plantMap.get(plantId);
    return plant ? plant.exp : 0;
}

/**
 * 根据果实ID获取植物名称
 * @param {number} fruitId - 果实ID
 */
function getFruitName(fruitId) {
    const plant = fruitToPlant.get(fruitId);
    return plant ? plant.name : `果实${fruitId}`;
}

/**
 * 根据果实ID获取植物信息
 * @param {number} fruitId - 果实ID
 */
function getPlantByFruitId(fruitId) {
    return fruitToPlant.get(fruitId);
}


/**
 * 根据物品ID获取物品配置
 * @param {number} itemId - 物品ID
 */
function getItemInfoById(itemId) {
    const id = Number(itemId) || 0;
    return itemInfoMap.get(id) || null;
}

/**
 * 根据物品ID获取名称（优先覆盖配置，再查 ItemInfo）
 * @param {number} itemId - 物品ID
 */
function getItemName(itemId) {
    const id = Number(itemId) || 0;
    const itemInfo = getItemInfoById(id);
    if (itemInfo && itemInfo.name) {
        return String(itemInfo.name);
    }
    const seedPlant = seedToPlant.get(id);
    if (seedPlant) return `${seedPlant.name}种子`;

    const fruitPlant = fruitToPlant.get(id);
    if (fruitPlant) return `${fruitPlant.name}果实`;

    return `未知物品`;
}

// ============ 种植效率排行（共享逻辑） ============

/**
 * 计算种植效率排行
 * @param {object} [opts]
 * @param {number} [opts.level]  - 若指定，仅返回 <= 该等级解锁的作物
 * @param {string} [opts.sort]   - 排序方式: 'expPerHour'(默认) | 'unlockLevel'
 * @returns {Array<{id,name,seedId,unlockLevel,exp,seasons,totalExp,growTimeSec,regrowSec,totalTimeSec,expPerHour}>}
 */
function getPlantRanking(opts = {}) {
    const plants = plantConfig || [];
    const level = opts.level || null;
    const sortBy = opts.sort || 'expPerHour';
    const result = [];

    for (const plant of plants) {
        if (!plant.seed_id) continue;
        // 过滤特殊/测试植物（ID 以 2020 开头，如新手引导白萝卜）
        if (String(plant.id).startsWith('2020')) continue;

        const seedItem = getItemInfoById(plant.seed_id);
        const unlockLevel = (seedItem && seedItem.level) ? seedItem.level : 0;
        if (level != null && unlockLevel > level) continue;
        // 过滤价格为 0 的免费种子（非正常商店种子）
        if (seedItem && seedItem.price === 0) continue;

        const exp = plant.exp || 0;
        const growTimeSec = getPlantGrowTime(plant.id) || 0;
        if (growTimeSec <= 0 || exp <= 0) continue;

        const seasons = plant.seasons || 1;

        // 计算多季作物的回生时间
        let regrowSec = 0;
        if (seasons > 1 && plant.grow_phases) {
            const phases = plant.grow_phases.split(';').filter(p => p.trim());
            const durations = phases.map(seg => {
                const m = seg.match(/:(\d+)/);
                return m ? parseInt(m[1]) : 0;
            }).filter(d => d > 0);
            if (durations.length > 0) {
                regrowSec = durations[durations.length - 1];
            }
        }

        const totalExp = exp * seasons;
        const totalTimeSec = growTimeSec + (seasons - 1) * regrowSec;
        const expPerHour = totalTimeSec > 0 ? Math.round((totalExp / totalTimeSec) * 3600 * 100) / 100 : 0;

        result.push({
            id: plant.id,
            name: plant.name,
            seedId: plant.seed_id,
            unlockLevel,
            exp,
            seasons,
            totalExp,
            growTimeSec,
            regrowSec,
            totalTimeSec,
            expPerHour,
        });
    }

    if (sortBy === 'unlockLevel') {
        result.sort((a, b) => a.unlockLevel - b.unlockLevel || b.expPerHour - a.expPerHour);
    } else {
        result.sort((a, b) => b.expPerHour - a.expPerHour);
    }

    return result;
}

// 启动时加载配置
loadConfigs();

module.exports = {
    loadConfigs,
    // 等级经验
    getLevelExpTable,
    getLevelExpProgress,
    // 植物配置
    getAllPlants: () => plantConfig || [],
    getPlantById,
    getPlantBySeedId,
    getPlantName,
    getPlantNameBySeedId,
    getPlantFruit,
    getPlantGrowTime,
    getPlantExp,
    formatGrowTime,
    // 果实配置
    getFruitName,
    getPlantByFruitId,
    // 物品配置
    getItemName,
    getItemInfo: getItemInfoById,
    getItemInfoById,
    // 种植效率排行
    getPlantRanking,
};
