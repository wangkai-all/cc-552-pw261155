'use strict';

/**
 * 本地模拟站点服务器：仅用 Node.js 内置模块。
 * 启动：node server.js（读取环境变量 PORT，默认 3000，绑定 127.0.0.1）
 */

const http = require('node:http');
const { runScenario } = require('./src/station');

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>本地模拟站点 · 节目预告收发台</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; background: #f4f5f7; color: #1f2430; }
  main { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .sub { color: #5b6472; font-size: 14px; margin: 0 0 24px; }
  .panel { background: #fff; border: 1px solid #e2e6ec; border-radius: 10px; padding: 20px; margin-bottom: 20px; }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; }
  button { font-size: 15px; padding: 10px 18px; border-radius: 8px; border: 1px solid #2f6fed; background: #2f6fed; color: #fff; cursor: pointer; }
  button:hover { background: #245bcc; }
  button:disabled { opacity: .55; cursor: wait; }
  h2 { font-size: 16px; margin: 0 0 12px; }
  pre { margin: 0; padding: 16px; background: #0f1420; color: #d7e0ee; border-radius: 8px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; min-height: 120px; }
  .hint { font-size: 13px; color: #5b6472; margin-top: 10px; }
  code { background: #eef1f6; padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
<main>
  <h1>本地模拟站点 · 节目预告收发台</h1>
  <p class="sub">虚构节目《夜航西飞》：v1 已齐套在播（整包留存）。字幕、演员表、无障碍说明与节目单分开发布；新版预告与在播版共用无障碍说明附件。</p>

  <section class="panel">
    <h2>操作</h2>
    <div class="actions">
      <button type="button" data-scenario="announce">接收节目预告</button>
      <button type="button" data-scenario="late-attachment">撤单后接收迟到附件</button>
      <button type="button" data-scenario="check-published">检查已发布节目文件</button>
    </div>
    <p class="hint">每个场景都从同一初始状态（v1 在播）重放，便于核对处理前后的计算结果。</p>
  </section>

  <section class="panel">
    <h2>业务结果</h2>
    <pre id="result" data-evidence-result="idle">（尚未操作，点击上方按钮运行场景）</pre>
  </section>
</main>
<script>
(function () {
  var el = document.getElementById('result');
  var buttons = document.querySelectorAll('button[data-scenario]');
  function setBusy(busy) {
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = busy;
  }
  function render(key, data) {
    el.setAttribute('data-evidence-result', key);
    el.textContent = '【' + data.title + '】\\n'
      + data.lines.join('\\n')
      + '\\n\\n---- 处理前 ----\\n' + JSON.stringify(data.before, null, 2)
      + '\\n\\n---- 处理后 ----\\n' + JSON.stringify(data.after, null, 2)
      + '\\n\\n---- 操作日志 ----\\n' + data.log.join('\\n');
  }
  function run(key) {
    setBusy(true);
    el.setAttribute('data-evidence-result', key + ':running');
    el.textContent = '处理中…';
    fetch('/api/demo/' + key, { method: 'POST' })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
          render(key, data);
        });
      })
      .catch(function (err) {
        el.setAttribute('data-evidence-result', key + ':error');
        el.textContent = '操作失败：' + err.message;
      })
      .then(function () { setBusy(false); });
  }
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('click', function (ev) {
      run(ev.currentTarget.getAttribute('data-scenario'));
    });
  }
})();
</script>
</body>
</html>
`;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/demo/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/demo/'.length));
      try {
        sendJson(res, 200, runScenario(name));
      } catch (err) {
        const status = err && err.code === 'UNKNOWN_SCENARIO' ? 404 : 500;
        sendJson(res, status, { error: err.message, code: err.code || 'INTERNAL' });
      }
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`本地模拟站点已启动: http://127.0.0.1:${port}`);
  });
}

module.exports = { createServer };
