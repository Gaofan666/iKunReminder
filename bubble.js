/* 气泡窗的渲染脚本：把主进程发来的内容填进去，并按屏幕缩放摆好几何。
   主进程只给「设计尺寸下的坐标」，这里负责换算成当前窗口里的实际尺寸 ——
   这样 bubble.html 里不用写任何 calc() 反算，兼容性更稳。 */
(function () {
  'use strict';
  var b = window.petBubble;
  if (!b) return;

  var el = {
    head: document.getElementById('head'),
    mer: document.getElementById('mer'),
    tip: document.getElementById('tip'),
    next: document.getElementById('next'),
    todos: document.getElementById('todos'),
    todoHead: document.getElementById('todoHead'),
    todoList: document.getElementById('todoList')
  };

  /* 今日待办那一块：没有就整块藏起来（气泡窗会按 main.js 算的高度显示） */
  function paintTodos(td) {
    if (!el.todos) return;
    var items = (td && td.items) || [];
    if (!items.length) { el.todos.hidden = true; el.todoList.innerHTML = ''; return; }
    el.todos.hidden = false;
    var left = (td.left != null) ? td.left : items.filter(function (x) { return !x.done; }).length;
    el.todoHead.textContent = '📋 今日待办 ' + td.total + ' 条' +
      (left > 0 ? '（' + left + ' 条没做完）' : '（都做完了）');
    el.todoList.innerHTML = '';
    items.forEach(function (it) {
      var row = document.createElement('div');
      row.className = 'pb-todo-row' + (it.done ? ' done' : '');
      var t = document.createElement('span');
      t.className = 't';
      t.textContent = it.time || '';
      var x = document.createElement('span');
      x.className = 'x';
      x.textContent = (it.done ? '✓ ' : '· ') + (it.text || '');
      row.appendChild(t);
      row.appendChild(x);
      el.todoList.appendChild(row);
    });
    if (td.more > 0) {
      var m = document.createElement('div');
      m.className = 'pb-todo-more';
      m.textContent = '…还有 ' + td.more + ' 条，点「待办」看全部';
      el.todoList.appendChild(m);
    }
  }

  b.onData(function (d) {
    if (!d) return;
    el.head.textContent = d.head || '';
    el.mer.textContent = d.mer || '';
    el.tip.textContent = d.tip || '';
    el.next.textContent = d.next || '';
    paintTodos(d.todos);

    var root = document.documentElement;
    var scale = Number(d.scale) > 0 ? Number(d.scale) : 1;
    if (d.innerW) root.style.setProperty('--bubble-w', Math.round(d.innerW) + 'px');
    if (d.innerH) root.style.setProperty('--bubble-h', Math.round(d.innerH) + 'px');
    if (d.pad != null) root.style.setProperty('--bubble-pad', Math.round(d.pad) + 'px');
    root.style.setProperty('--bubble-scale', String(scale));

    /* 尾巴是内层伪元素，内层被放大了 scale 倍，所以偏移要除回去，
       尾巴本身的尺寸也要乘 1/scale，才对得上 1 像素的边框。 */
    var safe = scale > 0.05 ? scale : 1;
    root.style.setProperty('--bubble-inv', String(1 / safe));
    root.style.setProperty('--tail', ((Number(d.tailPos) || 36) / safe) + 'px');
    document.body.className = 'tail-' + (d.tail || 'bottom');
  });
})();
