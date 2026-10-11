/**
 * 内容安全检测（客户端）。
 *
 * 微信审核要求：**凡是用户能发布出去的内容，发布前都要过内容安全接口**。
 * 我们的「分享图纸给好友」就是这种场景，所以发布前先送检。
 *
 * 链路：图片 → 传**云存储** → 把 fileID 交给云函数 → 云函数走云调用
 * 调 `security.imgSecCheck` → 删掉临时文件。
 * （先传云存储再传 fileID，是为了绕开 callFunction 的请求体大小限制。）
 *
 * 三种结果，调用方要分清：
 *   { pass: true }              → 通过，可以发布
 *   { pass: false }             → 检测到违规，**必须拦住**
 *   { pass: true, skipped: true } → 没检测成功（云没配/网络/图太大），**放行但不代表安全**
 */
const cloud = require('./cloud');

const FUNCTION_NAME = 'checkContent';

/** 云端临时文件放这个目录，检测完就删 */
const TMP_DIR = 'check-tmp';

function extOf(filePath) {
  const m = /\.(png|jpg|jpeg|webp|gif)$/i.exec(filePath || '');
  return m ? m[0].toLowerCase() : '.png';
}

function contentTypeOf(ext) {
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

/**
 * 送检一张本地图片。
 * @param {string} filePath 本地临时文件路径
 * @returns {Promise<{pass:boolean, skipped?:boolean, reason?:string, message?:string}>}
 */
async function checkImageFile(filePath) {
  if (!cloud.isReady()) return { pass: true, skipped: true, reason: 'cloud_not_ready' };

  const ext = extOf(filePath);
  const cloudPath = `${TMP_DIR}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  let fileID = '';

  try {
    const up = await wx.cloud.uploadFile({ cloudPath, filePath });
    fileID = up.fileID;

    const res = await wx.cloud.callFunction({
      name: FUNCTION_NAME,
      data: { fileID, contentType: contentTypeOf(ext) },
    });

    const r = (res && res.result) || {};
    if (!r.ok) {
      // 没检测成功（图太大 / 云函数报错 / 没部署）→ 放行，但不算「已通过」
      return { pass: true, skipped: true, reason: r.reason, message: r.message };
    }
    return { pass: !!r.pass };
  } catch (e) {
    console.error('内容安全检测失败', e);
    return {
      pass: true,
      skipped: true,
      reason: 'call_failed',
      message: (e && (e.errMsg || e.message)) || String(e),
    };
  } finally {
    // 临时文件删掉，别占云存储
    if (fileID) {
      try {
        await wx.cloud.deleteFile({ fileList: [fileID] });
      } catch (e) {
        /* 删不掉就算了，不影响主流程 */
      }
    }
  }
}

module.exports = { checkImageFile };
