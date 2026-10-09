/**
 * 二进制 <-> base64。
 *
 * 为什么手写而不用 `wx.arrayBufferToBase64`：
 *  1. 该 API 已被官方标记废弃（新版基础库推荐自己实现），行为在各版本不一致
 *  2. Node 里没有它 —— 手写版能直接在 Node 里拿 Buffer 当标准答案对拍，
 *     等于白捡一整套测试能力（见 tools/test-project.js）
 *
 * 不用 `String.fromCharCode.apply(null, arr)`：大数组会爆调用栈。
 * 这里用数组 push + join，600KB 级别也没问题。
 */
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// 反查表：字符 -> 6bit 值，-1 表示非法字符
const B64_LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < 64; i++) t[B64_CHARS.charCodeAt(i)] = i;
  return t;
})();

/**
 * @param {Uint8Array|Uint8ClampedArray} bytes
 * @returns {string} 标准 base64（含 `=` 补位）
 */
function bytesToBase64(bytes) {
  const parts = [];
  const len = bytes.length;
  let i = 0;

  for (; i + 2 < len; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    parts.push(
      B64_CHARS[(n >> 18) & 63] +
        B64_CHARS[(n >> 12) & 63] +
        B64_CHARS[(n >> 6) & 63] +
        B64_CHARS[n & 63]
    );
  }

  const rem = len - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    parts.push(B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + '==');
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    parts.push(
      B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + '='
    );
  }

  return parts.join('');
}

/**
 * 宽松解码：忽略换行/空格等非 base64 字符，容忍缺失的补位。
 * 数据被截断时**不抛异常**，返回能解出来的部分 —— 进度数据宁可少读出几格，
 * 也好过整个页面因为一个字符崩掉。
 * @param {string} str
 * @returns {Uint8Array}
 */
function base64ToBytes(str) {
  if (!str) return new Uint8Array(0);

  const vals = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const v = code < 256 ? B64_LOOKUP[code] : -1;
    if (v >= 0) vals.push(v);
  }

  const n = vals.length;
  if (n < 2) return new Uint8Array(0);

  const outLen = Math.floor((n * 3) / 4);
  const out = new Uint8Array(outLen);
  let oi = 0;
  let i = 0;

  for (; i + 3 < n; i += 4) {
    const x = (vals[i] << 18) | (vals[i + 1] << 12) | (vals[i + 2] << 6) | vals[i + 3];
    out[oi++] = (x >> 16) & 0xff;
    out[oi++] = (x >> 8) & 0xff;
    out[oi++] = x & 0xff;
  }

  const rem = n - i;
  if (rem === 3) {
    const x = (vals[i] << 18) | (vals[i + 1] << 12) | (vals[i + 2] << 6);
    out[oi++] = (x >> 16) & 0xff;
    out[oi++] = (x >> 8) & 0xff;
  } else if (rem === 2) {
    const x = (vals[i] << 18) | (vals[i + 1] << 12);
    out[oi++] = (x >> 16) & 0xff;
  }

  return oi === outLen ? out : out.slice(0, oi);
}

module.exports = { bytesToBase64, base64ToBytes };
