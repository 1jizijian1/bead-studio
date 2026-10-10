const store = require('./utils/store');
const cloud = require('./utils/cloud');

App({
  globalData: {
    /** 首页选好的图：{ path, width, height } */
    pickedImage: null,
    /** 编辑器产出的网格结果（大对象，只走内存，绝不进 setData/storage） */
    result: null,
    /** 用户偏好：色号体系、参数、导出选项 */
    settings: null,
  },

  onLaunch() {
    // 用户偏好是小对象，可以安全落 storage
    this.globalData.settings = store.loadSettings();
    // 云开发：没配 ENV_ID 就直接返回 false，其他功能不受影响
    cloud.init();
  },
});
