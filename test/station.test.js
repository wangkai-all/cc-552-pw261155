'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { StationStore, seedStore, runScenario } = require('../src/station');
const { createServer } = require('../server');

const V2_MANIFEST = [
  { id: 'file:sched-v2', name: '节目单-v2.json', kind: 'schedule' },
  { id: 'file:subs-v2', name: '字幕-v2.srt', kind: 'subtitles' },
  { id: 'file:cast-v2', name: '演员表-v2.json', kind: 'cast' },
  { id: 'file:a11y-yhxf', name: '无障碍说明-夜航西飞.txt', kind: 'accessibility' },
];

/* ---------- 正常流程 ---------- */

test('正常：种子数据中 v1 齐套并在播，已发布检查通过', () => {
  const store = seedStore();
  const check = store.checkPublished();
  assert.equal(check.current, 'yhxf@v1');
  assert.equal(check.ok, true);
  assert.deepEqual(check.missing, []);
  assert.equal(check.items.length, 4);
  assert.ok(check.totalBytes > 0);
});

test('正常：新预告与在播版本共用说明文件，共用附件不计入待收清单', () => {
  const store = seedStore();
  const reg = store.announce({ programId: 'yhxf', version: 'v2', retention: 'shared', requires: V2_MANIFEST });
  assert.equal(reg.status, 'pending');
  assert.deepEqual(reg.pending.sort(), ['file:cast-v2', 'file:sched-v2', 'file:subs-v2']);
  assert.ok(!reg.pending.includes('file:a11y-yhxf'), '共用的无障碍说明已在库，不应待收');
});

test('正常：附件收齐后版本齐套，播放服务完成切换', () => {
  const store = seedStore();
  store.announce({ programId: 'yhxf', version: 'v2', retention: 'shared', requires: V2_MANIFEST });
  store.receiveFile('file:sched-v2', '{}');
  store.receiveFile('file:subs-v2', 'srt');
  assert.equal(store.snapshot().announcements.find((a) => a.key === 'yhxf@v2').status, 'pending');
  store.receiveFile('file:cast-v2', '[]');
  assert.equal(store.snapshot().announcements.find((a) => a.key === 'yhxf@v2').status, 'complete');
  const sw = store.publish('yhxf', 'v2');
  assert.equal(sw.previous, 'yhxf@v1');
  assert.equal(sw.current, 'yhxf@v2');
});

test('正常：共用附件按文件共享，库内只存一份', () => {
  const store = seedStore();
  store.announce({ programId: 'yhxf', version: 'v2', retention: 'shared', requires: V2_MANIFEST });
  assert.deepEqual(store.referencing('file:a11y-yhxf').sort(), ['yhxf@v1', 'yhxf@v2']);
  assert.equal(store.files.size, 4, '共用文件不重复入库');
});

test('正常：撤回共用附件的预告后，已发布版本检查依然通过', () => {
  const store = seedStore();
  store.announce({ programId: 'yhxf', version: 'v2', retention: 'shared', requires: V2_MANIFEST });
  store.cancel('yhxf', 'v2');
  assert.ok(store.files.has('file:a11y-yhxf'), '撤单不得删除共用附件');
  const check = store.checkPublished();
  assert.equal(check.ok, true);
  assert.deepEqual(check.missing, []);
  const a11y = check.items.find((i) => i.id === 'file:a11y-yhxf');
  assert.equal(a11y.present, true);
});

test('正常：撤单后迟到的附件仍被接收并标记 late，撤单状态不变', () => {
  const store = seedStore();
  store.announce({ programId: 'yhxf', version: 'v3', retention: 'shared', requires: [
    { id: 'file:subs-v3', name: '字幕-v3.srt', kind: 'subtitles' },
  ] });
  store.cancel('yhxf', 'v3');
  const rec = store.receiveFile('file:subs-v3', '1\n00:00:01,000 --> 00:00:02,000\n迟到。\n');
  assert.equal(rec.late, true);
  assert.ok(store.files.has('file:subs-v3'));
  assert.equal(store.snapshot().announcements.find((a) => a.key === 'yhxf@v3').status, 'cancelled');
});

test('正常：撤单后待收清单作废', () => {
  const store = seedStore();
  store.announce({ programId: 'yhxf', version: 'v2', retention: 'shared', requires: V2_MANIFEST });
  assert.equal(store.pendingOf('yhxf@v2').length, 3);
  store.cancel('yhxf', 'v2');
  assert.deepEqual(store.pendingOf('yhxf@v2'), []);
});

/* ---------- 异常流程 ---------- */

test('异常：未齐套的版本，播放服务拒绝切换', () => {
  const store = seedStore();
  store.announce({ programId: 'yhxf', version: 'v2', retention: 'shared', requires: V2_MANIFEST });
  assert.throws(() => store.publish('yhxf', 'v2'), /INCOMPLETE|未齐套/);
  assert.equal(store.snapshot().current, 'yhxf@v1', '切换失败不应改动在播版本');
});

test('异常：已撤单的版本不能上线', () => {
  const store = seedStore();
  store.announce({ programId: 'yhxf', version: 'v2', retention: 'shared', requires: V2_MANIFEST });
  store.cancel('yhxf', 'v2');
  assert.throws(() => store.publish('yhxf', 'v2'), /CANCELLED|已撤单/);
});

test('异常：重复登记同一预告被拒绝', () => {
  const store = seedStore();
  assert.throws(
    () => store.announce({ programId: 'yhxf', version: 'v1', requires: V2_MANIFEST }),
    /DUPLICATE_ANNOUNCEMENT|重复/,
  );
});

test('异常：未预告过的文件被拒收', () => {
  const store = seedStore();
  assert.throws(() => store.receiveFile('file:ghost', 'x'), /UNKNOWN_FILE|拒收/);
  assert.ok(!store.files.has('file:ghost'));
});

test('异常：重复投递同一文件被拒绝', () => {
  const store = seedStore();
  assert.throws(() => store.receiveFile('file:subs-v1', 'again'), /DUPLICATE_DELIVERY|重复投递/);
});

test('异常：正在播出的版本不能撤单', () => {
  const store = seedStore();
  assert.throws(() => store.cancel('yhxf', 'v1'), /CANNOT_CANCEL_PUBLISHED|不能撤单/);
});

test('异常：重复撤单被拒绝', () => {
  const store = seedStore();
  store.announce({ programId: 'yhxf', version: 'v2', retention: 'shared', requires: V2_MANIFEST });
  store.cancel('yhxf', 'v2');
  assert.throws(() => store.cancel('yhxf', 'v2'), (err) => err.code === 'ALREADY_CANCELLED');
});

test('异常：没有已发布版本时无法检查', () => {
  const store = new StationStore();
  assert.throws(() => store.checkPublished(), (err) => err.code === 'NOTHING_PUBLISHED');
});

test('异常：已发布版本缺文件时检查不通过并列出缺失', () => {
  const store = seedStore();
  store.files.delete('file:subs-v1'); // 模拟库内文件丢失
  const check = store.checkPublished();
  assert.equal(check.ok, false);
  assert.deepEqual(check.missing, ['file:subs-v1']);
});

test('异常：非法留存方式与空清单被拒绝', () => {
  const store = new StationStore();
  assert.throws(
    () => store.announce({ programId: 'p', version: 'v1', retention: 'weird', requires: V2_MANIFEST }),
    (err) => err.code === 'BAD_RETENTION',
  );
  assert.throws(
    () => store.announce({ programId: 'p', version: 'v1', requires: [] }),
    (err) => err.code === 'EMPTY_MANIFEST',
  );
});

/* ---------- 演示场景与 HTTP ---------- */

test('场景：接收节目预告后，在播版本从 v1 切到 v2 且共用附件只有一份', () => {
  const r = runScenario('announce');
  assert.equal(r.before.current, 'yhxf@v1');
  assert.equal(r.after.current, 'yhxf@v2');
  assert.equal(r.after.fileCount, 7);
  const a11yRefs = r.after.announcements.filter((a) => a.received.includes('file:a11y-yhxf'));
  assert.equal(a11yRefs.length, 2, '新旧版本都引用共用附件');
});

test('场景：撤单后迟到附件仍入库，在播版本不变', () => {
  const r = runScenario('late-attachment');
  assert.equal(r.after.current, 'yhxf@v1');
  const late = r.after.files.find((f) => f.id === 'file:subs-v3');
  assert.ok(late && late.late === true);
  assert.equal(r.after.announcements.find((a) => a.key === 'yhxf@v3').status, 'cancelled');
});

test('场景：撤单共用附件的预告后，已发布检查仍然通过', () => {
  const r = runScenario('check-published');
  assert.equal(r.before.ok, true);
  assert.equal(r.after.ok, true);
  assert.equal(r.after.current, 'yhxf@v1');
});

test('场景：未知场景报错', () => {
  assert.throws(() => runScenario('nope'), /UNKNOWN_SCENARIO|未知场景/);
});

test('HTTP：页面含 data-evidence-result 结果区，三个演示接口返回前后对比', async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /data-evidence-result/);
  assert.match(html, /接收节目预告/);
  assert.match(html, /撤单后接收迟到附件/);
  assert.match(html, /检查已发布节目文件/);

  for (const key of ['announce', 'late-attachment', 'check-published']) {
    const res = await fetch(`${base}/api/demo/${key}`, { method: 'POST' });
    assert.equal(res.status, 200, key);
    const data = await res.json();
    assert.ok(data.before && data.after, `${key} 应返回处理前后对比`);
    assert.ok(Array.isArray(data.lines) && data.lines.length > 0);
  }

  const missing = await fetch(`${base}/api/demo/nope`, { method: 'POST' });
  assert.equal(missing.status, 404);

  const notFound = await fetch(`${base}/nope`);
  assert.equal(notFound.status, 404);
});
