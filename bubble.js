/* 气泡窗的渲染脚本：只负责把主进程发来的内容填进去 */
(function () {
  'use strict';
  var b = window.petBubble;
  if (!b) return;

  var el = {
    head: document.getElementById('head'),
    mer: document.getElementById('mer'),
    tip: document.getElementById('tip'),
    next: document.getElementById('next')
  };

  b.onData(function (d) {
    if (!d) return;
    el.head.textContent = d.head || '';
    el.mer.textContent = d.mer || '';
    el.tip.textContent = d.tip || '';
    el.next.textContent = d.next || '';
    document.body.className = 'tail-' + (d.tail || 'bottom');
    document.body.style.setProperty('--tail', (d.tailPos || 36) + 'px');
  });
})();
