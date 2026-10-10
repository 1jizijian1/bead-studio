const projectStore = require('../../utils/projectStore');
const codec = require('../../utils/projectCodec');
const canvasHelper = require('../../utils/canvasHelper');

/** 相对时间，给「上次拼到哪」一点时间感 */
function timeAgo(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  const min = Math.floor(d / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return '昨天';
  if (day < 30) return `${day} 天前`;
  const dt = new Date(ts);
  return `${dt.getMonth() + 1} 月 ${dt.getDate()} 日`;
}

Page({
  data: {
    list: [],
    usageText: '',
    usageWarn: false,
    empty: false,
  },

  onShow() {
    this.load();
  },

  load() {
    const raw = projectStore.listProjects();
    const usage = projectStore.getStorageUsage();

    // 有打卡照片的直接显示照片；没有的才用 canvas 画图纸缩略图。
    // 注意 canvas 只给「没有照片」的那些项，所以要记下它们对应列表里的第几个，
    // 否则 selectAll 拿到的节点顺序跟列表项对不上。
    this.thumbs = [];
    this.needCanvas = [];
    raw.forEach((m, k) => {
      if (m.cover) {
        this.thumbs.push(null);
        return;
      }
      this.needCanvas.push(k);
      this.thumbs.push(m.thumb && m.thumb.cells ? codec.unpackThumb(m.thumb) : null);
    });

    const list = raw.map((m) => {
      const pct = m.total ? Math.round((m.done / m.total) * 100) : 0;
      return {
        id: m.id,
        name: m.name,
        dims: `${m.dims.N}×${m.dims.M}`,
        done: m.done,
        total: m.total,
        percent: pct,
        finished: pct >= 100,
        cover: m.cover || '',
        updated: timeAgo(m.updatedAt),
        colorCount: m.colorCount || 0,
      };
    });

    // setData 是异步的：必须等渲染回调再查缩略图 canvas，否则列表项还没生成、
    // selectorQuery 一个节点都查不到
    this.setData(
      {
        list,
        empty: list.length === 0,
        usageText: `已用 ${(usage.currentSizeKB / 1024).toFixed(1)} MB / ${(usage.limitSizeKB / 1024).toFixed(0)} MB`,
        usageWarn: usage.ratio > 0.8,
      },
      () => {
        if (this.needCanvas.length) this.drawThumbs();
      }
    );
  },

  /** 一次查询拿到所有缩略图 canvas 节点，按 needCanvas 里的下标对应回列表项 */
  async drawThumbs() {
    const nodes = await new Promise((resolve) => {
      wx.createSelectorQuery()
        .in(this)
        .selectAll('.thumb-canvas')
        .fields({ node: true, size: true })
        .exec((res) => resolve(res && res[0] ? res[0] : []));
    });

    const dpr = canvasHelper.getPixelRatio();
    for (let k = 0; k < nodes.length; k++) {
      const info = nodes[k];
      const thumb = this.thumbs[this.needCanvas[k]];
      if (!info || !info.node || !thumb) continue;

      const cssW = info.width;
      const cssH = info.height;
      const canvas = info.node;
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cssW, cssH);

      const cw = cssW / thumb.w;
      const ch = cssH / thumb.h;
      // 按颜色批量画，避免每格切一次 fillStyle
      const byColor = new Map();
      for (let y = 0; y < thumb.h; y++) {
        for (let x = 0; x < thumb.w; x++) {
          const v = thumb.cells[y * thumb.w + x];
          if (!v) continue;
          const hex = thumb.hexes[v - 1];
          if (!hex) continue;
          let arr = byColor.get(hex);
          if (!arr) {
            arr = [];
            byColor.set(hex, arr);
          }
          arr.push(x, y);
        }
      }
      byColor.forEach((coords, hex) => {
        ctx.fillStyle = hex;
        for (let t = 0; t < coords.length; t += 2) {
          ctx.fillRect(coords[t] * cw, coords[t + 1] * ch, cw + 0.5, ch + 0.5);
        }
      });
    }
  },

  onOpen(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/craft/index?id=${id}` });
  },

  onCheckin(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/checkin/index?id=${id}` });
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name || '这个项目';
    wx.showModal({
      title: '删除项目',
      content: `「${name}」和它的拼豆进度都会被删掉，无法恢复。确定吗？`,
      confirmText: '删除',
      confirmColor: '#dc2626',
      success: (m) => {
        if (!m.confirm) return;
        projectStore.deleteProject(id);
        wx.showToast({ title: '已删除', icon: 'none' });
        this.load();
      },
    });
  },

  onGoGenerate() {
    wx.navigateBack();
  },
});
