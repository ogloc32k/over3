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
      const level = String(log.message || '').match(/^\[(INFO|WARN|ERROR)\]/i)?.[1]?.toLowerCase() || 'info';
      r.className = `log-entry log-${level}`;
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = `[${new Date(log.time).toLocaleTimeString()}]`;
      const msg = document.createElement('span');
      msg.className = 'msg';
      msg.textContent = log.message || '';
      r.append(ts, msg);
      box.appendChild(r);
    });
    while (box.children.length > 200) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  });

  console.log('📋 logs.js loaded');
})();
