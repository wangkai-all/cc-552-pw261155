'use strict';

/**
 * 本地模拟站点：节目预告 / 收件 / 撤单 / 播放切换 的领域逻辑。
 *
 * 模型：
 *  - 预告(announcement)：某节目某版本的文件清单（节目单、字幕、演员表、无障碍说明…），
 *    各文件可分开发布、先后到达。收件器据此维护「待收清单」。
 *  - 文件库(files)：按文件 ID 只存一份。多个版本可共用同一附件（按文件共享），
 *    预告也可声明整包留存(retention: 'package')，两种模式都只是留存策略标记，
 *    撤单一律不删库内文件。
 *  - 播放服务：只能切换到「齐套」(complete) 的版本。
 *  - 撤单(cancel)：作废旧预告的待收清单，但不动已入库附件；
 *    撤单后迟到的附件仍被接收（late=true），已发布版本的共用附件不受影响。
 */

class StationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StationError';
    this.code = code;
  }
}

class StationStore {
  constructor() {
    this.files = new Map(); // fileId -> { id, name, kind, content, bytes, late, receivedAt }
    this.expected = new Map(); // fileId -> { id, name, kind } 预告登记过的文件元数据
    this.announcements = new Map(); // key -> { key, programId, version, retention, requires, status, cancelledAt }
    this.current = null; // 正在播出的版本 key
    this.log = [];
  }

  static keyOf(programId, version) {
    return `${programId}@${version}`;
  }

  /** 登记节目预告，返回该预告当前的待收清单。 */
  announce({ programId, version, retention = 'shared', requires }) {
    if (retention !== 'shared' && retention !== 'package') {
      throw new StationError('BAD_RETENTION', `未知留存方式: ${retention}（仅支持 shared 按文件共享 / package 整包留存）`);
    }
    const key = StationStore.keyOf(programId, version);
    if (this.announcements.has(key)) {
      throw new StationError('DUPLICATE_ANNOUNCEMENT', `预告已存在，重复登记被拒绝: ${key}`);
    }
    if (!Array.isArray(requires) || requires.length === 0) {
      throw new StationError('EMPTY_MANIFEST', '预告必须至少列出一个文件');
    }
    const ids = new Set();
    for (const f of requires) {
      if (!f || !f.id) throw new StationError('BAD_MANIFEST', '清单条目缺少文件 id');
      if (ids.has(f.id)) throw new StationError('DUPLICATE_FILE_IN_MANIFEST', `清单内文件重复: ${f.id}`);
      ids.add(f.id);
      if (!this.expected.has(f.id)) {
        this.expected.set(f.id, { id: f.id, name: f.name || f.id, kind: f.kind || 'misc' });
      }
    }
    const ann = {
      key, programId, version, retention,
      requires: [...ids],
      status: 'pending',
      cancelledAt: null,
    };
    this.announcements.set(key, ann);
    this.#refresh(ann);
    const pending = this.pendingOf(key);
    this.log.push(`预告登记 ${key}（${retention === 'package' ? '整包留存' : '按文件共享'}），待收 ${pending.length} 个文件`);
    return { key, status: ann.status, pending };
  }

  /** 某版本当前的待收清单（已撤单版本视为已作废，返回空）。 */
  pendingOf(key) {
    const ann = this.#ann(key);
    if (ann.status === 'cancelled') return [];
    return ann.requires.filter((id) => !this.files.has(id));
  }

  /** 引用某文件的全部预告 key（含已撤单）。 */
  referencing(fileId) {
    return [...this.announcements.values()]
      .filter((a) => a.requires.includes(fileId))
      .map((a) => a.key);
  }

  /** 收件器：附件到达。未预告过的文件拒收；撤单后迟到的附件仍接收并标记 late。 */
  receiveFile(fileId, content) {
    const meta = this.expected.get(fileId);
    if (!meta) {
      throw new StationError('UNKNOWN_FILE', `未在任何预告中登记，拒收: ${fileId}`);
    }
    if (this.files.has(fileId)) {
      throw new StationError('DUPLICATE_DELIVERY', `文件已在库中，重复投递被拒绝: ${fileId}`);
    }
    const refs = this.referencing(fileId);
    const late = refs.length > 0 && refs.every((key) => this.announcements.get(key).status === 'cancelled');
    const record = {
      ...meta,
      content: String(content),
      bytes: Buffer.byteLength(String(content)),
      late,
      receivedAt: new Date().toISOString(),
    };
    this.files.set(fileId, record);
    for (const key of refs) this.#refresh(this.announcements.get(key));
    this.log.push(`收件 ${fileId}（${record.bytes} 字节）${late ? '，属撤单后迟到附件，仍入库留存' : ''}`);
    return record;
  }

  /** 撤单：作废待收清单；不删除任何已入库文件（已发布版本可能正共用它们）。 */
  cancel(programId, version) {
    const key = StationStore.keyOf(programId, version);
    const ann = this.#ann(key);
    if (ann.status === 'cancelled') {
      throw new StationError('ALREADY_CANCELLED', `预告已是撤单状态: ${key}`);
    }
    if (this.current === key) {
      throw new StationError('CANNOT_CANCEL_PUBLISHED', `正在播出的版本不能撤单: ${key}`);
    }
    ann.status = 'cancelled';
    ann.cancelledAt = new Date().toISOString();
    this.log.push(`撤单 ${key}，待收清单作废；已入库共享附件全部保留`);
    return { key, status: ann.status };
  }

  /** 播放服务切换版本：只允许切到齐套版本。 */
  publish(programId, version) {
    const key = StationStore.keyOf(programId, version);
    const ann = this.#ann(key);
    if (ann.status === 'cancelled') {
      throw new StationError('CANCELLED', `已撤单的版本不能上线: ${key}`);
    }
    if (ann.status !== 'complete') {
      const missing = this.pendingOf(key);
      throw new StationError('INCOMPLETE', `未齐套，播放服务拒绝切换: ${key}，仍缺 ${missing.join('、')}`);
    }
    const previous = this.current;
    this.current = key;
    this.log.push(`播放服务切换: ${previous || '(无)'} -> ${key}`);
    return { previous, current: key };
  }

  /** 检查已发布版本：清单内文件是否全部在库、各自大小与共享关系。 */
  checkPublished() {
    if (!this.current) {
      throw new StationError('NOTHING_PUBLISHED', '当前没有已发布版本可检查');
    }
    const ann = this.#ann(this.current);
    const items = ann.requires.map((id) => {
      const f = this.files.get(id);
      const meta = this.expected.get(id);
      return {
        id,
        name: (f && f.name) || (meta && meta.name) || id,
        present: Boolean(f),
        bytes: f ? f.bytes : 0,
        late: f ? f.late : false,
        sharedBy: this.referencing(id),
      };
    });
    const missing = items.filter((i) => !i.present).map((i) => i.id);
    return {
      current: this.current,
      ok: missing.length === 0,
      missing,
      totalBytes: items.reduce((sum, i) => sum + i.bytes, 0),
      items,
    };
  }

  /** 状态快照，用于页面对比「处理前 / 处理后」。 */
  snapshot() {
    return {
      current: this.current,
      fileCount: this.files.size,
      files: [...this.files.values()].map((f) => ({
        id: f.id, name: f.name, kind: f.kind, bytes: f.bytes, late: f.late,
      })),
      announcements: [...this.announcements.values()].map((a) => ({
        key: a.key,
        retention: a.retention,
        status: a.status,
        pending: this.pendingOf(a.key),
        received: a.requires.filter((id) => this.files.has(id)),
      })),
    };
  }

  #ann(key) {
    const ann = this.announcements.get(key);
    if (!ann) throw new StationError('NO_SUCH_ANNOUNCEMENT', `预告不存在: ${key}`);
    return ann;
  }

  #refresh(ann) {
    if (ann.status === 'cancelled') return;
    ann.status = ann.requires.every((id) => this.files.has(id)) ? 'complete' : 'pending';
  }
}

/* ---------------- 虚构数据与演示场景 ---------------- */

const A11Y_FILE = { id: 'file:a11y-yhxf', name: '无障碍说明-夜航西飞.txt', kind: 'accessibility' };

function v1Manifest() {
  return [
    { id: 'file:sched-v1', name: '节目单-v1.json', kind: 'schedule' },
    { id: 'file:subs-v1', name: '字幕-v1.srt', kind: 'subtitles' },
    { id: 'file:cast-v1', name: '演员表-v1.json', kind: 'cast' },
    A11Y_FILE,
  ];
}

function manifestFor(version, extraCast) {
  return [
    { id: `file:sched-${version}`, name: `节目单-${version}.json`, kind: 'schedule' },
    { id: `file:subs-${version}`, name: `字幕-${version}.srt`, kind: 'subtitles' },
    { id: `file:cast-${version}`, name: `演员表-${version}.json`, kind: 'cast' },
    A11Y_FILE, // 新旧节目共用同一份无障碍说明
  ];
}

/** 初始状态：虚构节目《夜航西飞》v1 已齐套并在播（整包留存）。 */
function seedStore() {
  const store = new StationStore();
  store.announce({ programId: 'yhxf', version: 'v1', retention: 'package', requires: v1Manifest() });
  store.receiveFile('file:sched-v1', JSON.stringify({ title: '夜航西飞', slot: '20:00', durationMin: 95 }));
  store.receiveFile('file:subs-v1', '1\n00:00:01,000 --> 00:00:03,000\n风起了。\n');
  store.receiveFile('file:cast-v1', JSON.stringify([{ role: '机长', actor: '沈青禾' }, { role: '气象员', actor: '何远洲' }]));
  store.receiveFile('file:a11y-yhxf', '无障碍说明：全片配口述影像轨，字幕白底黑字，含手语窗。');
  store.publish('yhxf', 'v1');
  return store;
}

/** 场景一：接收节目预告 —— 新版 v2 与在播 v1 共用无障碍说明，收齐后切换。 */
function scenarioAnnounce() {
  const store = seedStore();
  const before = store.snapshot();

  const reg = store.announce({ programId: 'yhxf', version: 'v2', retention: 'shared', requires: manifestFor('v2') });
  store.receiveFile('file:sched-v2', JSON.stringify({ title: '夜航西飞', slot: '21:30', durationMin: 95, note: 'v2 调档' }));
  store.receiveFile('file:subs-v2', '1\n00:00:01,000 --> 00:00:03,000\n风停了。\n');
  store.receiveFile('file:cast-v2', JSON.stringify([{ role: '机长', actor: '沈青禾' }, { role: '塔台', actor: '陆闻笛' }]));
  store.publish('yhxf', 'v2');

  const after = store.snapshot();
  const lines = [
    `处理前：在播 ${before.current}；库内文件 ${before.fileCount} 个；预告 ${before.announcements.length} 条`,
    `预告到达：yhxf@v2 清单 4 个文件，其中 file:a11y-yhxf 与在播 v1 共用、已在库，实际待收 ${reg.pending.length} 个（${reg.pending.join('、')}）`,
    `处理后：在播 ${after.current}；库内文件 ${after.fileCount} 个；yhxf@v2 状态 complete（齐套，播放服务已切换）`,
    `共享核对：file:a11y-yhxf 被 ${store.referencing('file:a11y-yhxf').join('、')} 引用，库内仍只存 1 份（按文件共享，未重复留存）`,
  ];
  return { key: 'announce', title: '接收节目预告', lines, before, after, log: store.log };
}

/** 场景二：撤单后接收迟到附件 —— v3 撤单，迟到的字幕仍入库，已撤单版本拒绝上线。 */
function scenarioLateAttachment() {
  const store = seedStore();
  const before = store.snapshot();

  store.announce({ programId: 'yhxf', version: 'v3', retention: 'shared', requires: manifestFor('v3') });
  store.receiveFile('file:sched-v3', JSON.stringify({ title: '夜航西飞', slot: '23:00', durationMin: 95 }));
  store.cancel('yhxf', 'v3');
  const lateFile = store.receiveFile('file:subs-v3', '1\n00:00:01,000 --> 00:00:03,000\n灯亮了。\n');

  let blocked = '';
  try {
    store.publish('yhxf', 'v3');
  } catch (err) {
    blocked = `${err.code}: ${err.message}`;
  }

  const after = store.snapshot();
  const lines = [
    `处理前：在播 ${before.current}；库内文件 ${before.fileCount} 个`,
    '预告 yhxf@v3 到达，仅收到 file:sched-v3 后站点撤单，待收清单（file:subs-v3、file:cast-v3）作废',
    `迟到附件：file:subs-v3 在撤单后到达，仍被接收入库（late=${lateFile.late}，${lateFile.bytes} 字节）`,
    `异常拦截：${blocked}`,
    `处理后：在播仍为 ${after.current}；库内文件 ${after.fileCount} 个；yhxf@v3 状态 cancelled，未影响在播版本`,
  ];
  return { key: 'late-attachment', title: '撤单后接收迟到附件', lines, before, after, log: store.log };
}

/** 场景三：检查已发布节目文件 —— 共用附件的新预告撤单后，在播版本文件依然齐全。 */
function scenarioCheckPublished() {
  const store = seedStore();
  const before = store.checkPublished();

  store.announce({ programId: 'yhxf', version: 'v2', retention: 'shared', requires: manifestFor('v2') });
  store.cancel('yhxf', 'v2'); // 撤回共用无障碍说明的新预告

  const after = store.checkPublished();
  const a11y = after.items.find((i) => i.id === 'file:a11y-yhxf');
  const lines = [
    `处理前检查：${before.current} 应含 ${before.items.length} 个文件，缺失 ${before.missing.length} 个，ok=${before.ok}，共 ${before.totalBytes} 字节`,
    '操作：登记 yhxf@v2（与在播版本共用 file:a11y-yhxf）随即撤单',
    `处理后检查：${after.current} 缺失 ${after.missing.length} 个，ok=${after.ok}；file:a11y-yhxf 仍在库（present=${a11y.present}），引用方 ${a11y.sharedBy.join('、')}`,
    '结论：撤单只作废旧预告的待收清单，已发布版本的共用附件不受影响',
  ];
  return { key: 'check-published', title: '检查已发布节目文件', lines, before, after, log: store.log };
}

const SCENARIOS = {
  announce: scenarioAnnounce,
  'late-attachment': scenarioLateAttachment,
  'check-published': scenarioCheckPublished,
};

function runScenario(name) {
  const fn = SCENARIOS[name];
  if (!fn) throw new StationError('UNKNOWN_SCENARIO', `未知场景: ${name}`);
  return fn();
}

module.exports = {
  StationStore,
  StationError,
  seedStore,
  runScenario,
  SCENARIOS,
};
