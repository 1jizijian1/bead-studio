/**
 * 微信云开发：把图纸传到云端，好友点分享卡片就能拿到并自己拼。
 *
 * 为什么要它：图纸数据存在**本地 storage**，分享给好友时好友那边没有这份数据。
 * 分享图片只能让好友「看」，想让他「拼」就必须把图纸传上云。
 *
 * ┌─ 需要你做的（一次性）─────────────────────────────┐
 * │ 1. 微信公众平台 → 开发 → 云开发 → 开通（个人小程序也能开，有免费额度）│
 * │ 2. 创建一个环境，把环境 ID 填到下面的 ENV_ID                      │
 * │ 3. 云开发控制台 → 数据库 → 新建集合 `patterns`                     │
 * │ 4. 该集合的权限设为「**所有用户可读，仅创建者可读写**」           │
 * │    ⚠️ 默认是「仅创建者可读写」，那样好友读不到                     │
 * └──────────────────────────────────────────────────┘
 *
 * 没配 ENV_ID 也能正常用 —— 所有云功能会优雅降级（按钮提示「未开通云开发」）。
 */

/** 云开发环境 ID。填上之后云功能自动生效 */
const ENV_ID = 'cloudbase-d1gp9tt7m149cd7c4';

const COLLECTION = 'patterns';

/**
 * 云数据库**单文档上限 512KB**（客户端 SDK）。
 * 图纸最大约 132KB（300×169 格），加上包装也远没到，但还是挡一道。
 */
const MAX_DOC_BYTES = 400 * 1024;

let inited = false;

function isReady() {
  return !!ENV_ID && typeof wx !== 'undefined' && !!wx.cloud;
}

/** 初始化（只做一次）。返回是否可用 */
function init() {
  if (!isReady()) return false;
  if (inited) return true;
  try {
    wx.cloud.init({ env: ENV_ID, traceUser: true });
    inited = true;
  } catch (e) {
    console.error('云开发初始化失败', e);
    return false;
  }
  return true;
}

/**
 * 上传一张图纸。
 * @param {object} p { name, dims, colorSystem, hexes, cellsB64, beadTotal, colorCount }
 * @returns {Promise<{ok:boolean, id?:string, reason?:string}>}
 */
async function uploadPattern(p) {
  if (!init()) return { ok: false, reason: 'not_configured' };

  const record = {
    v: 1,
    name: p.name || '拼豆图纸',
    dims: p.dims,
    colorSystem: p.colorSystem || 'MARD',
    hexes: p.hexes,
    cells: p.cellsB64,
    beadTotal: p.beadTotal || 0,
    colorCount: (p.hexes || []).length,
    createdAt: Date.now(),
  };

  if (JSON.stringify(record).length > MAX_DOC_BYTES) {
    return { ok: false, reason: 'too_big' };
  }

  try {
    const res = await wx.cloud.database().collection(COLLECTION).add({ data: record });
    return { ok: true, id: res._id };
  } catch (e) {
    console.error('上传图纸失败', e);
    return { ok: false, reason: 'upload_failed', message: e && (e.errMsg || e.message) };
  }
}

/**
 * 拉取一张分享过来的图纸。
 * @returns {Promise<{ok:boolean, data?:object, reason?:string}>}
 */
async function fetchPattern(id) {
  if (!init()) return { ok: false, reason: 'not_configured' };
  if (!id) return { ok: false, reason: 'bad_id' };

  try {
    const res = await wx.cloud.database().collection(COLLECTION).doc(id).get();
    if (!res || !res.data) return { ok: false, reason: 'not_found' };
    return { ok: true, data: res.data };
  } catch (e) {
    console.error('读取图纸失败', e);
    return { ok: false, reason: 'fetch_failed', message: e && (e.errMsg || e.message) };
  }
}

module.exports = {
  ENV_ID,
  COLLECTION,
  isReady,
  init,
  uploadPattern,
  fetchPattern,
};
