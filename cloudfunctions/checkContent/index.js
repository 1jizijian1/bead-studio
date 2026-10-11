/**
 * 内容安全检测（云函数）。
 *
 * 为什么需要它：微信审核拒绝了「UGC 类小程序未接入内容安全 API」——
 * 我们的「分享图纸给好友」让用户能把内容发布出去，所以发布前必须送检。
 *
 * 为什么用云函数：`security.imgSecCheck` 需要 access_token。
 * 在云函数里走**云调用**（`cloud.openapi.*`）就不用自己管理 token 了。
 * ⚠️ 云调用要在同目录的 `config.json` 里声明权限，否则会报「无权限调用」。
 *
 * 输入：{ fileID, contentType }
 *   图片先传到**云存储**再把 fileID 传进来 —— 避免 callFunction 的请求体大小限制。
 * 输出：{ ok, pass, reason?, message? }
 *   ok=false 表示「没检测成功」（网络/权限/图太大），调用方要自己决定怎么处理
 *   pass=false 表示「检测到违规内容」
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/** 微信内容安全接口对图片的限制：不超过 1MB */
const MAX_BYTES = 1024 * 1024;

/** 87014 = 内容含有违法违规内容 */
const ERR_RISKY = 87014;

exports.main = async (event) => {
  const fileID = event && event.fileID;
  const contentType = (event && event.contentType) || 'image/png';

  if (!fileID) return { ok: false, reason: 'bad_input' };

  let buffer;
  try {
    const res = await cloud.downloadFile({ fileID });
    buffer = res && res.fileContent;
  } catch (e) {
    return { ok: false, reason: 'download_failed', message: e && (e.errMsg || e.message) };
  }

  if (!buffer || !buffer.length) return { ok: false, reason: 'empty_file' };
  if (buffer.length > MAX_BYTES) return { ok: false, reason: 'too_big', size: buffer.length };

  try {
    await cloud.openapi.security.imgSecCheck({
      media: { contentType, value: buffer },
    });
    return { ok: true, pass: true };
  } catch (e) {
    const code = e && (e.errCode || e.errcode);
    if (code === ERR_RISKY) {
      // 检测成功，且判定为违规
      return { ok: true, pass: false };
    }
    return {
      ok: false,
      reason: 'check_failed',
      code,
      message: e && (e.errMsg || e.message),
    };
  }
};
