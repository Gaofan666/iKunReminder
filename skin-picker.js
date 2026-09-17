/* =========================================================================
   skin-picker.js —— 皮肤「取列表 / 载入」的薄封装（主界面与桌面宠物窗共用）
   -------------------------------------------------------------------------
   为什么单独成文件：这部分要调主进程桥（native，读磁盘），而 pet-draw.js
   只管绘制、不该认识 Electron。所以绘制留在 pet-draw.js，
   「问主进程要列表、要图片」放这里。

   两个使用方各注入一次桥：
     initSkinPicker(window.kunkunNative, { onList, onCaption })
   之后调用 skinsList() / loadSkin(id) / fillSkinPicker(selectEl, current, onPicked)。
   ========================================================================= */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.kunkunSkinPicker = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var bridge = null;      // preload 暴露的 native 桥
  var pet = null;         // pet-draw 模块（用来把图交给它）
  var hooks = { onList: null, onCaption: null };

  function init(nativeBridge, petDraw, h) {
    bridge = nativeBridge || null;
    pet = petDraw || null;
    hooks.onList = (h && h.onList) || null;
    hooks.onCaption = (h && h.onCaption) || null;
    if (pet && pet.setCaptionHandler && hooks.onCaption) pet.setCaptionHandler(hooks.onCaption);
  }

  function skinsList() {
    if (!bridge || !bridge.skinsList) return Promise.resolve([]);
    return bridge.skinsList().then(function (list) {
      if (hooks.onList) hooks.onList(list || []);
      return list || [];
    }).catch(function () { return []; });
  }

  /* 载入某个形象并把精灵图交给 pet-draw 绘制（图由主进程读成 data URL） */
  function loadSkin(id) {
    if (!bridge || !bridge.skinLoad || !pet) return Promise.resolve(null);
    return bridge.skinLoad(id).then(function (data) {
      pet.applySkin(data);
      return data;
    }).catch(function () { return null; });
  }

  /* 填充 <select>：currentSkin(list) 由调用方给出「当前该选哪个」，
     并且要顺手把「存着的皮肤已经不存在」这种情况退回默认（返回值即最终选中项）。 */
  function fillSkinPicker(selectEl, currentSkin) {
    if (!selectEl) return Promise.resolve('__default');
    return skinsList().then(function (list) {
      selectEl.innerHTML = '';
      (list || []).forEach(function (s) {
        var o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.name;                 // 只显示名字，不带作者后缀
        selectEl.appendChild(o);
      });
      var picked = typeof currentSkin === 'function' ? currentSkin(list) : '__default';
      selectEl.value = picked;
      return picked;
    });
  }

  return {
    init: init,
    skinsList: skinsList,
    loadSkin: loadSkin,
    fillSkinPicker: fillSkinPicker
  };
});
