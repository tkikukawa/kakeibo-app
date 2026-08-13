// GitHub をデータストアとして扱う層。
//
// 設計上の約束:
//   - entries/YYYY-MM.jsonl は追記のみ。既存行は書き換えない
//   - 追記は id で重複排除するので、途中で失敗して再送しても二重にならない
//   - 同時編集で sha が競合したら読み直して再試行する
//   - オフライン中は IndexedDB に溜め、オンラインになったら即送る
//     （端末のストレージは OS に消される可能性があるので溜め込まない）

const API = 'https://api.github.com';
const CFG_KEY = 'kakeibo.config';

export const config = {
  get() {
    try {
      return JSON.parse(localStorage.getItem(CFG_KEY)) ?? {};
    } catch {
      return {};
    }
  },
  set(patch) {
    const next = { ...this.get(), ...patch };
    localStorage.setItem(CFG_KEY, JSON.stringify(next));
    return next;
  },
  get ready() {
    const c = this.get();
    return Boolean(c.token && c.owner && c.repo);
  },
};

// --- base64 (UTF-8) ---------------------------------------------------------
const b64encode = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64decode = (b64) => {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

// --- GitHub API -------------------------------------------------------------
async function gh(method, path, body) {
  const { token } = config.get();
  if (!token) throw new Error('PAT が設定されていません');
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error('PAT が無効か失効しています');
  if (res.status === 404) return { status: 404, data: null };
  if (res.status === 409) return { status: 409, data: null };
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`GitHub API ${res.status}: ${detail.slice(0, 200)}`);
  }
  return { status: res.status, data: res.status === 204 ? null : await res.json() };
}

const repoPath = (p) => {
  const { owner, repo } = config.get();
  return `/repos/${owner}/${repo}/contents/${p}`;
};

export async function getFile(path) {
  const { status, data } = await gh('GET', repoPath(path));
  if (status === 404) return null;
  return { text: b64decode(data.content), sha: data.sha };
}

export async function putFile(path, text, sha, message) {
  const body = { message, content: b64encode(text) };
  if (sha) body.sha = sha;
  return gh('PUT', repoPath(path), body);
}

export async function listDir(path) {
  const { status, data } = await gh('GET', repoPath(path));
  return status === 404 ? [] : data;
}

// --- 読み込み ---------------------------------------------------------------
export async function loadSettings() {
  const [accounts, categories, rules] = await Promise.all(
    ['accounts.json', 'categories.json', 'rules.json'].map(async (f) => {
      const file = await getFile(f);
      return file ? JSON.parse(file.text) : null;
    })
  );
  if (!accounts) throw new Error('accounts.json が見つかりません');
  return { accounts, categories: categories ?? {}, rules: rules ?? [] };
}

const parseJsonl = (text) =>
  text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

export async function loadEntries() {
  const files = await listDir('entries');
  const months = files
    .filter((f) => f.name.endsWith('.jsonl'))
    .map((f) => f.name.replace('.jsonl', ''))
    .sort();
  const chunks = await Promise.all(
    months.map(async (m) => {
      const file = await getFile(`entries/${m}.jsonl`);
      return file ? parseJsonl(file.text) : [];
    })
  );
  return chunks.flat();
}

// --- 追記 -------------------------------------------------------------------
// 同じ月のファイルに追記する。すでに同じ id があればスキップするので、
// 再送しても二重にならない。sha が競合したら読み直して再試行する。
async function appendToMonth(month, entries, tries = 5) {
  const path = `entries/${month}.jsonl`;
  for (let i = 0; i < tries; i++) {
    const file = await getFile(path);
    const existing = file ? parseJsonl(file.text) : [];
    const known = new Set(existing.map((e) => e.id));
    const fresh = entries.filter((e) => !known.has(e.id));
    if (fresh.length === 0) return { written: 0 };

    const lines = fresh.map((e) => JSON.stringify(e)).join('\n');
    const text = file && file.text.trim() ? `${file.text.trimEnd()}\n${lines}\n` : `${lines}\n`;
    const { status } = await putFile(
      path,
      text,
      file?.sha,
      `${fresh.length}件を記録 (${month})`
    );
    if (status !== 409) return { written: fresh.length };
    // 別の端末が先に書いた。読み直して再試行する
    await new Promise((r) => setTimeout(r, 300 * (i + 1)));
  }
  throw new Error('競合が続いたため書き込めませんでした。時間をおいて再試行します');
}

export async function pushEntries(entries) {
  const byMonth = {};
  for (const e of entries) (byMonth[e.date.slice(0, 7)] ??= []).push(e);
  let written = 0;
  for (const [month, list] of Object.entries(byMonth)) {
    written += (await appendToMonth(month, list)).written;
  }
  return written;
}

export async function saveJson(path, obj, message) {
  const file = await getFile(path);
  await putFile(path, `${JSON.stringify(obj, null, 2)}\n`, file?.sha, message);
}

// --- オフライン用のキュー（IndexedDB） --------------------------------------
const DB = 'kakeibo';
const STORE = 'outbox';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
  });
}

export const outbox = {
  add: (entries) =>
    withStore('readwrite', (s) => entries.forEach((e) => s.put(e))),
  all: () => withStore('readonly', (s) => s.getAll()),
  remove: (ids) => withStore('readwrite', (s) => ids.forEach((id) => s.delete(id))),
  count: async () => (await outbox.all()).length,
};

// 記録する。オンラインなら即送信し、キューを溜め込まない。
// 失敗したらキューに残し、次の flush で再送する（id 重複排除があるので安全）。
export async function record(entries) {
  await outbox.add(entries);
  if (navigator.onLine && config.ready) {
    try {
      await pushEntries(entries);
      await outbox.remove(entries.map((e) => e.id));
      return { sent: true };
    } catch (err) {
      return { sent: false, error: err.message };
    }
  }
  return { sent: false, error: navigator.onLine ? 'PAT 未設定' : 'オフライン' };
}

export async function flush() {
  if (!navigator.onLine || !config.ready) return { sent: 0 };
  const pending = await outbox.all();
  if (pending.length === 0) return { sent: 0 };
  await pushEntries(pending);
  await outbox.remove(pending.map((e) => e.id));
  return { sent: pending.length };
}
