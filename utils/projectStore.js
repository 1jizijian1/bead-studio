/**
 * 拼豆项目存取：索引、图纸、进度，以及节流落盘。
 *
 * 设计要点（都是踩过/想过坑才这么定的）：
 *
 * 1. **图纸和进度分两个 key**。拼的过程中只有进度在变，图纸不变。
 *    合在一起的话每次节流保存都要重写整张图纸（最大 132KB）。
 *
 * 2. **节流不是防抖**。连着点格子只在第一次排一个定时器，到点写「当时最新的」数据。
 *
 * 3. **`onHide`/`onUnload` 必须 `flushSync()`**。异步写可能还没执行进程就没了。
 *    切后台、锁屏、接电话都会触发 onHide，那里同步写最可靠。
 *
 * 4. **不拦用户离开**（不调 `wx.enableAlertBeforeUnload`、不弹「确定要离开吗」）。
 *    进度是自动保存的，加拦截反而会让人以为「不点确认就丢了」。
 *    ⚠️ 后人别「好心」加上。
 *
 * 5. **storage 后端可注入**，所以整套能在 Node 里测（tools/test-project.js）。
 */
const codec = require('./projectCodec');

const INDEX_KEY = 'beadProjects';
const PROJECT_PREFIX = 'beadProject_';
const PROGRESS_PREFIX = 'beadProgress_';

/** 软上限。达到就不让再建 —— 不做自动淘汰，静默丢别人的进度不可接受 */
const MAX_PROJECTS = 12;
/** 单项目格数上限（300x300 是 9 万，留足余量但仍防住异常输入） */
const MAX_CELLS = 300000;
/** 节流间隔 */
const DEFAULT_THROTTLE_MS = 1500;

let throttleMs = DEFAULT_THROTTLE_MS;

// ---------------- storage 后端 ----------------

/**
 * storage 后端。**全部走同步 API**：
 * 进度载荷很小（≤9KB），同步写约 1ms；换异步只会多一个「写还没落盘进程就没了」
 * 的窗口，没有实际收益。真正需要保证的一定能落盘的场合是 onHide，那里本来也是同步。
 * （若真机实测同步写阻塞 >30ms，再考虑把节流路径改成 wx.setStorage。）
 */
function createWxStorage() {
  return {
    getSync: (k) => wx.getStorageSync(k),
    setSync: (k, v) => wx.setStorageSync(k, v),
    removeSync: (k) => wx.removeStorageSync(k),
    allKeys: () => {
      try {
        return wx.getStorageInfoSync().keys || [];
      } catch (e) {
        return [];
      }
    },
    usage: () => {
      try {
        const i = wx.getStorageInfoSync();
        return { currentSizeKB: i.currentSize, limitSizeKB: i.limitSize };
      } catch (e) {
        return { currentSizeKB: 0, limitSizeKB: 10240 };
      }
    },
  };
}

let storage = null;
function getStorage() {
  if (!storage) storage = createWxStorage();
  return storage;
}

/** 测试用：注入 storage 后端 */
function __setStorage(impl) {
  storage = impl;
}
/** 测试用：改节流间隔 */
function __setThrottleMs(ms) {
  throttleMs = ms;
}

// ---------------- 索引 ----------------

function readIndex() {
  const raw = getStorage().getSync(INDEX_KEY);
  return Array.isArray(raw) ? raw : [];
}

function writeIndex(list) {
  getStorage().setSync(INDEX_KEY, list);
}

/**
 * 清掉僵尸条目：索引里有、但数据 key 已经没了。
 * 小程序没有「按前缀删」，所以只能这样校验。
 * 顺带修「数据 key 被系统清理但索引还在」的情况。
 */
function pruneZombies() {
  const list = readIndex();
  if (list.length === 0) return list;
  const present = new Set(getStorage().allKeys());
  // allKeys 拿不到（异常）时不做裁剪，宁可留着也别误删
  if (present.size === 0) return list;
  const alive = list.filter((m) => present.has(PROJECT_PREFIX + m.id));
  if (alive.length !== list.length) writeIndex(alive);
  return alive;
}

function listProjects() {
  const list = pruneZombies();
  return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getProjectMeta(id) {
  return readIndex().find((m) => m.id === id) || null;
}

// ---------------- 建档 ----------------

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * 用当前网格建一个项目（**快照**：之后编辑器里改参数不影响它）。
 * @returns {{ok:boolean, id?:string, reason?:string}}
 */
function createFromGrid(params) {
  const grid = params.grid;
  const dims = params.dims;
  const total = dims.N * dims.M;

  if (!grid || !dims || total <= 0) return { ok: false, reason: 'bad_input' };
  if (total > MAX_CELLS) return { ok: false, reason: 'too_big' };

  const list = pruneZombies();
  if (list.length >= MAX_PROJECTS) return { ok: false, reason: 'too_many' };

  const id = newId();
  const packed = codec.packGrid(grid, dims);
  const record = {
    v: 1,
    id,
    dims,
    colorSystem: params.colorSystem || 'MARD',
    hexes: packed.hexes,
    cells: codec.packCells(packed.cells),
    // 指纹：编辑器里反复调滑块后再进进度模式时，靠它判断「复用旧项目」还是「覆盖重置」
    cellsHash: codec.hashGrid(packed.hexes, packed.cells),
    settings: params.settings || null,
  };

  // 先写大头（最容易撞配额），失败就整体失败，不留半个项目
  try {
    getStorage().setSync(PROJECT_PREFIX + id, record);
  } catch (e) {
    return { ok: false, reason: 'quota' };
  }

  const progress = {
    v: 1,
    done: codec.packProgress(codec.createBitmap(total)),
    view: null,
    currentColor: null,
    updatedAt: Date.now(),
  };
  try {
    getStorage().setSync(PROGRESS_PREFIX + id, progress);
  } catch (e) {
    getStorage().removeSync(PROJECT_PREFIX + id); // 回滚，别留孤儿
    return { ok: false, reason: 'quota' };
  }

  const stats = codec.countProgress(grid, dims, codec.createBitmap(total));
  const meta = {
    id,
    name: params.name || `图纸 ${dims.N}×${dims.M}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dims,
    done: 0,
    total: stats.beadTotal,
    colorCount: packed.hexes.length,
    thumb: params.thumb || '',
  };
  const next = list.concat([meta]);
  try {
    writeIndex(next);
  } catch (e) {
    getStorage().removeSync(PROJECT_PREFIX + id);
    getStorage().removeSync(PROGRESS_PREFIX + id);
    return { ok: false, reason: 'quota' };
  }

  return { ok: true, id };
}

// ---------------- 读取 ----------------

/**
 * 读项目。图纸和进度都对不上时兜底（reconcileProgress）。
 * @returns {null | {id, name, dims, colorSystem, hexes, cells, grid, bitmap, view, currentColor, dropped}}
 */
function loadProject(id) {
  const store = getStorage();
  const record = store.getSync(PROJECT_PREFIX + id);
  if (!record || !record.dims || !record.hexes || !record.cells) return null;

  const dims = record.dims;
  const cells = codec.unpackCells(record.cells, dims.N * dims.M);
  if (cells.length !== dims.N * dims.M) return null; // 数据残缺
  const grid = codec.unpackGrid(dims, record.hexes, cells);

  const saved = store.getSync(PROGRESS_PREFIX + id) || {};
  const rawBitmap = codec.unpackProgress(saved.done || '', dims.N * dims.M);
  const rec = codec.reconcileProgress(rawBitmap, grid, dims);

  const meta = getProjectMeta(id) || {};
  return {
    id,
    name: meta.name || `图纸 ${dims.N}×${dims.M}`,
    dims,
    colorSystem: record.colorSystem || 'MARD',
    hexes: record.hexes,
    cells,
    grid,
    bitmap: rec.bm,
    view: saved.view || null,
    currentColor: saved.currentColor || null,
    dropped: rec.dropped,
    changed: rec.changed,
  };
}

/**
 * 用新网格覆盖已有项目，**并重置进度**。
 *
 * 用途：编辑器里改了参数（图纸内容变了）后再点「开始拼豆」——
 * 复用同一个项目而不是新建，否则反复调滑块会攒出一堆孤儿项目。
 * 因为图纸变了，旧进度逐格对不上，所以直接清零（简单、可预期）。
 */
function overwrite(id, params) {
  const grid = params.grid;
  const dims = params.dims;
  const total = dims.N * dims.M;
  if (!grid || !dims || total <= 0) return { ok: false, reason: 'bad_input' };
  if (total > MAX_CELLS) return { ok: false, reason: 'too_big' };
  if (!getProjectMeta(id)) return { ok: false, reason: 'not_found' };

  const packed = codec.packGrid(grid, dims);
  const record = {
    v: 1,
    id,
    dims,
    colorSystem: params.colorSystem || 'MARD',
    hexes: packed.hexes,
    cells: codec.packCells(packed.cells),
    cellsHash: codec.hashGrid(packed.hexes, packed.cells),
    settings: params.settings || null,
  };

  try {
    getStorage().setSync(PROJECT_PREFIX + id, record);
    getStorage().setSync(PROGRESS_PREFIX + id, {
      v: 1,
      done: codec.packProgress(codec.createBitmap(total)),
      view: null,
      currentColor: null,
      updatedAt: Date.now(),
    });
  } catch (e) {
    return { ok: false, reason: 'quota' };
  }

  // 进度清零了，索引里的 done 也要跟着归零
  const stats = codec.countProgress(grid, dims, codec.createBitmap(total));
  const list = readIndex();
  const idx = list.findIndex((m) => m.id === id);
  if (idx >= 0) {
    list[idx].dims = dims;
    list[idx].done = 0;
    list[idx].total = stats.beadTotal;
    list[idx].colorCount = packed.hexes.length;
    list[idx].updatedAt = Date.now();
    if (params.thumb) list[idx].thumb = params.thumb;
    try {
      writeIndex(list);
    } catch (e) {
      return { ok: false, reason: 'quota' };
    }
  }

  return { ok: true, id };
}

/** 图纸指纹，供编辑器判断能否复用现有项目 */
function getCellsHash(id) {
  const record = getStorage().getSync(PROJECT_PREFIX + id);
  return record ? record.cellsHash || null : null;
}

function renameProject(id, name) {
  const list = readIndex();
  const idx = list.findIndex((m) => m.id === id);
  if (idx < 0) return false;
  list[idx].name = name;
  list[idx].updatedAt = Date.now();
  try {
    writeIndex(list);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 打卡照片的存取。
 *
 * 照片 1~3MB，**绝对不能进 storage**（单 key 上限 1MB）。
 * 所以用 `FileSystemManager.saveFile` 落到 `USER_DATA_PATH` 拿一个永久路径，
 * 索引里只存这个路径。
 *
 * ⚠️ `wx.chooseMedia` 给的是**临时路径**，App 重启就失效 —— 必须先拷走。
 */
function saveCover(id, tempFilePath) {
  return new Promise((resolve, reject) => {
    let fs;
    try {
      fs = wx.getFileSystemManager();
    } catch (e) {
      reject(new Error('拿不到文件系统'));
      return;
    }
    const ext = /\.(png|jpg|jpeg|webp)$/i.exec(tempFilePath);
    const target = `${wx.env.USER_DATA_PATH}/cover_${id}${ext ? ext[0] : '.jpg'}`;

    fs.saveFile({
      tempFilePath,
      filePath: target,
      success: (res) => {
        // 记进索引（meta.cover）。以后接云端时这里换成上传后拿到的 url
        const list = readIndex();
        const idx = list.findIndex((m) => m.id === id);
        if (idx >= 0) {
          list[idx].cover = res.savedFilePath;
          list[idx].updatedAt = Date.now();
          try {
            writeIndex(list);
          } catch (e) {
            /* 索引写失败不影响照片已经存下这件事 */
          }
        }
        resolve(res.savedFilePath);
      },
      fail: (e) => reject(new Error((e && e.errMsg) || '照片保存失败')),
    });
  });
}

/** 删项目时顺手把照片文件也删了，别留孤儿 */
function deleteCover(id) {
  const list = readIndex();
  const meta = list.find((m) => m.id === id);
  if (!meta || !meta.cover) return;
  try {
    wx.getFileSystemManager().unlink({ filePath: meta.cover, fail: () => {} });
  } catch (e) {
    /* 文件可能已经不在了，忽略 */
  }
}

function deleteProject(id) {
  const store = getStorage();
  deleteCover(id); // 顺手把打卡照片文件删掉，别留孤儿
  store.removeSync(PROJECT_PREFIX + id);
  store.removeSync(PROGRESS_PREFIX + id);
  writeIndex(readIndex().filter((m) => m.id !== id));
  if (pending.has(id)) {
    if (pending.get(id).timer) clearTimeout(pending.get(id).timer);
    pending.delete(id);
  }
  return true;
}

// ---------------- 节流落盘 ----------------

/** id -> { timer, data } */
const pending = new Map();
/** 上次落盘失败原因（供 UI 查询） */
let lastError = null;

function buildProgressRecord(id, data) {
  return {
    v: 1,
    done: codec.packProgress(data.bitmap),
    view: data.view || null,
    currentColor: data.currentColor || null,
    updatedAt: Date.now(),
  };
}

function writeProgressRecord(id, data) {
  getStorage().setSync(PROGRESS_PREFIX + id, buildProgressRecord(id, data));

  const list = readIndex();
  const idx = list.findIndex((m) => m.id === id);
  if (idx < 0) return;

  // done 由 store 自己从位图算，**不接受调用方传入** ——
  // 否则调用方忘了传，索引里的进度就会静默变旧，首页列表显示错的数字。
  // 位图末字节的填充位恒为 0，所以直接数整个 buffer 的置位数就是对的。
  list[idx].done = codec.countBits(data.bitmap, data.bitmap.length * 8);
  list[idx].updatedAt = Date.now();
  writeIndex(list);
}

/**
 * 标记有改动，节流落盘。**节流不是防抖**：只排一个定时器，到点写最新的数据。
 * @param {string} id
 * @param {{bitmap:Uint8Array, view:object, currentColor:string, stats?:object}} data
 */
function markDirty(id, data) {
  let entry = pending.get(id);
  if (!entry) {
    entry = { timer: null, data: null };
    pending.set(id, entry);
  }
  entry.data = data; // 后写覆盖先写 —— 到点落盘的是最新状态
  if (entry.timer) return; // 已经有定时器了，不重复排
  entry.timer = setTimeout(() => {
    const e = pending.get(id);
    if (!e) return;
    e.timer = null;
    const latest = e.data;
    pending.delete(id);
    try {
      writeProgressRecord(id, latest);
      lastError = null;
    } catch (err) {
      // 写失败不破坏内存模型；把数据放回去等下次 flushSync 再试
      lastError = { id, reason: 'quota' };
      pending.set(id, { timer: null, data: latest });
    }
  }, throttleMs);
}

/**
 * 立刻同步落盘，不等节流定时器。
 *
 * 为什么需要它：进度页原来是「节流 1.5 秒 + onHide 时强制落盘」，
 * 但**用户直接杀掉小程序时 onHide 不一定触发**（开发者工具和真机都一样），
 * 那 1.5 秒没到的话数据就丢了。
 *
 * 而进度数据才 1~9KB，同步写一次约 1ms —— 压根没慢到需要节流。
 * 所以改成**每次改动都立刻落盘**，节流那套只留作兼容。
 */
function saveNow(id, data) {
  const entry = pending.get(id);
  if (entry) {
    if (entry.timer) clearTimeout(entry.timer);
    pending.delete(id);
  }
  try {
    writeProgressRecord(id, data);
    lastError = null;
    return true;
  } catch (e) {
    lastError = { id, reason: 'quota' };
    return false;
  }
}

/** onHide / onUnload：把还挂着的都写下去（保险用的第二道） */
function flushSync() {
  let ok = true;
  pending.forEach((entry, id) => {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (!entry.data) return;
    try {
      writeProgressRecord(id, entry.data);
    } catch (e) {
      ok = false;
      lastError = { id, reason: 'quota' };
    }
  });
  pending.clear();
  // 全部写成功就把错误状态清掉 —— 否则 UI 会一直挂着「未保存」的警告
  if (ok) lastError = null;
  return ok;
}

function getLastError() {
  return lastError;
}

/** 存储用量，首页在 ratio > 0.8 时给用户预警 */
function getStorageUsage() {
  const u = getStorage().usage();
  const limit = u.limitSizeKB || 10240;
  return {
    currentSizeKB: u.currentSizeKB || 0,
    limitSizeKB: limit,
    ratio: limit > 0 ? (u.currentSizeKB || 0) / limit : 0,
  };
}

module.exports = {
  MAX_PROJECTS,
  MAX_CELLS,
  listProjects,
  getProjectMeta,
  getCellsHash,
  createFromGrid,
  overwrite,
  renameProject,
  loadProject,
  saveCover,
  deleteCover,
  deleteProject,
  markDirty,
  saveNow,
  flushSync,
  getLastError,
  getStorageUsage,
  __setStorage,
  __setThrottleMs,
  __pendingCount: () => pending.size,
};
