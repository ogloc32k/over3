// ============================================================
// logs.js – Log stream handling
// ============================================================
(function () {
  window.clearLogs = function () {
    const stream = document.getElementById('log-stream');
    if (stream) stream.innerHTML = '';
  };

  window.scrollLogsToBottom = function () {
    const box = document.getElementById('log-stream');
    if (box) box.scrollTop = box.scrollHeight;
  };

  // Listen for new logs from SSE (core.js)
  QuantCore.eventBus.on('new-logs', (logs) => {
    const box = document.getElementById('log-stream');
    if (!box) return;
    logs.forEach(log => {
      const r = document.createElement('div');
      r.className = 'log-entry';
      r.innerHTML = `<span class="ts">[${new Date(log.time).toLocaleTimeString()}]</span><span class="msg">${log.message}</span>`;
      box.appendChild(r);
    });
    while (box.children.length > 200) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  });

  console.log('📋 logs.js loaded');
})();
