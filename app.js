import * as M from './model.js';
import * as S from './store.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const CACHE = 'kakeibo.cache';
const state = { accounts: {}, categories: {}, rules: [], entries: [], balances: {} };

// --- 画面切り替え -----------------------------------------------------------
const VIEWS = ['home', 'record', 'count', 'inbox', 'settings'];
function show(name) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  window.scrollTo(0, 0);
  if (name === 'record') renderRecord();
  if (name === 'count') renderCount();
  if (name === 'inbox') renderInbox();
  if (name === 'settings') renderSettings();
  if (name === 'home') renderHome();
}
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) show(go.dataset.go);
});

let bannerTimer;
function banner(msg, kind = 'ok', ms = 3000) {
  const b = $('banner');
  b.textContent = msg;
  b.className = `banner ${kind}`;
  b.hidden = false;
  clearTimeout(bannerTimer);
  if (ms) bannerTimer = setTimeout(() => (b.hidden = true), ms);
}

// --- データ -----------------------------------------------------------------
function recompute() {
  const live = M.liveEntries(M.sortEntries(state.entries));
  state.live = live;
  try {
    state.balances = M.computeBalances(state.accounts, live);
    state.problem = M.checkInvariant(state.accounts, live, state.balances);
  } catch (err) {
    state.balances = {};
    state.problem = { message: err.message };
  }
}

function saveCache() {
  try {
    localStorage.setItem(
      CACHE,
      JSON.stringify({
        accounts: state.accounts,
        categories: state.categories,
        rules: state.rules,
        entries: state.entries,
      })
    );
  } catch {
    /* 容量超過などは無視。次回オンライン時に取り直す */
  }
}

function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE));
    if (!c) return false;
    Object.assign(state, c);
    recompute();
    return true;
  } catch {
    return false;
  }
}

async function sync({ quiet = false } = {}) {
  if (!S.config.ready) {
    state.sync = { ok: false, msg: 'PAT が未設定です' };
    return false;
  }
  if (!navigator.onLine) {
    state.sync = { ok: false, msg: 'オフライン' };
    if (!quiet) banner('オフラインです。入力は端末に保存されます', 'warn');
    return false;
  }
  try {
    const sent = await S.flush();
    if (sent.sent > 0) banner(`未送信 ${sent.sent} 件を送信しました`, 'ok');
    const [settings, entries] = await Promise.all([S.loadSettings(), S.loadEntries()]);
    Object.assign(state, settings, { entries });
    recompute();
    saveCache();
    state.sync = { ok: true, msg: '', at: Date.now() };
    return true;
  } catch (err) {
    // 同期できていないことは画面に出し続ける。バナーは消えても状態は残す。
    state.sync = { ok: false, msg: err.message };
    if (!quiet) banner(err.message, 'err', 6000);
    return false;
  }
}

// 記録して、送信状況をユーザーに伝える
async function commit(entries, okMsg) {
  state.entries.push(...entries);
  recompute();
  saveCache();
  const res = await S.record(entries);
  banner(res.sent ? okMsg : `${okMsg}（未送信: ${res.error}）`, res.sent ? 'ok' : 'warn');
  show('home');
}

// --- ホーム -----------------------------------------------------------------
function renderHome() {
  const now = new Date();
  const w = '日月火水木金土'[now.getDay()];
  $('home-date').textContent = `${now.getMonth() + 1}月${now.getDate()}日 (${w})`;

  const month = M.today().slice(0, 7);
  $('home-month').textContent = M.yen(M.monthTotal(state.live ?? [], month));
  $('home-inbox').textContent = `${M.inbox(state.live ?? []).length} 件`;

  const list = $('home-balances');
  list.replaceChildren();
  for (const [id, acc] of Object.entries(state.accounts)) {
    const li = el('li');
    li.append(el('span', null, acc.name));
    if (M.isTracked(acc)) {
      const bal = state.balances[id] ?? 0;
      const amt = el('span', `amt${bal < 0 ? ' neg' : ''}`, M.yen(bal));
      if (acc.type === 'credit' && bal < 0) amt.title = '未払額';
      li.append(amt);
    } else {
      li.append(el('span', 'note', 'チャージ時に支出計上'));
    }
    list.append(li);
  }
  $('home-networth').textContent = M.yen(M.netWorth(state.balances));

  const check = $('home-check');
  if (state.problem) {
    check.textContent = state.problem.message
      ? `検算エラー: ${state.problem.message}`
      : `検算が合いません（差 ${M.yen(state.problem.expected - state.problem.actual)}）。振替の設定を確認してください`;
    check.style.color = 'var(--danger)';
  } else {
    check.textContent = '';
  }

  refreshStatus();
}

// 同期状態を正直に出す。同期できていないのに「同期済み」と表示すると、
// PAT の期限切れに気づかないまま入力し続けてしまう。
async function refreshStatus() {
  const line = $('home-sync');
  const pending = await S.outbox.count().catch(() => 0);
  let text;
  let bad = true;
  if (!S.config.ready) text = '未設定 — 右上から PAT を設定してください';
  else if (!navigator.onLine) text = 'オフライン（入力は端末に保存されます）';
  else if (state.sync?.ok === false) text = `同期できていません: ${state.sync.msg}`;
  else if (state.sync?.ok) {
    text = '同期済み';
    bad = false;
  } else text = '未同期';
  if (pending) text += ` ・ 未送信 ${pending} 件`;
  line.textContent = text;
  line.style.color = bad || pending ? 'var(--danger)' : 'var(--muted)';
}

// --- 支出を記録 -------------------------------------------------------------
let rec = { account: null, category: null };

function chipRow(container, items, selected, onPick) {
  container.replaceChildren();
  for (const [value, label] of items) {
    const b = el('button', 'chip', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(value === selected));
    b.onclick = () => onPick(value);
    container.append(b);
  }
}

function renderRecord() {
  const accounts = Object.entries(state.accounts).map(([id, a]) => [id, a.name]);
  chipRow($('rec-accounts'), accounts, rec.account, (v) => {
    rec.account = v;
    renderRecord();
  });
  const cats = Object.entries(state.categories)
    .filter(([, c]) => !c.system)
    .map(([id, c]) => [id, c.name]);
  chipRow($('rec-categories'), cats, rec.category, (v) => {
    rec.category = rec.category === v ? null : v;
    renderRecord();
  });

  const acc = state.accounts[rec.account];
  $('rec-note').textContent = !acc
    ? '支払い手段を選んでください'
    : acc.type === 'cash'
      ? '現金の支出として確定します'
      : '速報として記録します。後日CSVの明細と自動で統合されます';
}

$('rec-save').onclick = async () => {
  const amount = parseInt(($('rec-amount').value || '').replace(/[^0-9]/g, ''), 10);
  if (!amount) return banner('金額を入力してください', 'err');
  if (!rec.account) return banner('支払い手段を選んでください', 'err');

  const merchant = $('rec-merchant').value.trim() || null;
  const acc = state.accounts[rec.account];
  const isCash = acc.type === 'cash';
  const category = rec.category ?? M.guessCategory(merchant, state.rules);

  const entry = {
    id: M.ulid(),
    ts: M.nowTs(),
    date: M.today(),
    kind: 'expense',
    amount,
    account: rec.account,
    status: isCash && category ? 'confirmed' : isCash ? 'pending' : 'provisional',
    source: 'manual',
  };
  if (category) entry.category = category;
  if (merchant) entry.merchant = merchant;

  $('rec-amount').value = '';
  $('rec-merchant').value = '';
  rec = { account: null, category: null };
  await commit([entry], `${M.yen(amount)} を記録しました`);
};

// --- 財布を数える -----------------------------------------------------------
function predictedCash() {
  return state.balances.cash ?? 0;
}

function renderCount() {
  $('count-predicted').textContent = M.yen(predictedCash());
  $('count-actual').value = '';
  updateDiff();
}

function updateDiff() {
  const raw = ($('count-actual').value || '').replace(/[^0-9]/g, '');
  const box = $('count-diff');
  if (!raw) {
    box.className = 'diff';
    box.textContent = '数えた額を入力すると差額が出ます';
    return;
  }
  const diff = predictedCash() - parseInt(raw, 10);
  box.className = diff === 0 ? 'diff' : 'diff on';
  box.textContent =
    diff === 0
      ? 'ぴったり合っています'
      : diff > 0
        ? `${M.yen(diff)} 少ない → 使途不明として計上します`
        : `${M.yen(-diff)} 多い → 不明な増加として計上します`;
}
$('count-actual').addEventListener('input', updateDiff);

$('count-save').onclick = async () => {
  const raw = ($('count-actual').value || '').replace(/[^0-9]/g, '');
  if (raw === '') return banner('数えた額を入力してください', 'err');
  const actual = parseInt(raw, 10);
  const diff = predictedCash() - actual;
  const base = { ts: M.nowTs(), date: M.today(), account: 'cash', source: 'manual' };

  const entries = [
    { ...base, id: M.ulid(), kind: 'count', amount: actual, status: 'confirmed' },
  ];
  if (diff !== 0) {
    entries.push({
      ...base,
      id: M.ulid(),
      kind: diff > 0 ? 'expense' : 'income',
      amount: Math.abs(diff),
      category: diff > 0 ? 'unknown' : 'unknown_income',
      status: 'confirmed',
      source: 'reconcile',
      memo: '現金照合による調整',
    });
  }
  await commit(entries, diff === 0 ? '照合しました（ぴったり）' : '照合しました');
};

// --- 未処理トレイ -----------------------------------------------------------
function renderInbox() {
  const box = $('inbox-list');
  box.replaceChildren();
  const items = M.inbox(state.live ?? []);
  if (items.length === 0) {
    box.append(el('p', 'empty', '未処理はありません'));
    return;
  }
  const cats = Object.entries(state.categories)
    .filter(([, c]) => !c.system)
    .map(([id, c]) => [id, c.name]);

  for (const e of items.slice().reverse()) {
    const card = el('div', 'item');
    const row = el('div', 'row');
    row.append(el('span', 'name', e.merchant || state.accounts[e.account]?.name || '—'));
    row.append(el('span', 'amt', M.yen(e.amount)));
    card.append(row);

    const acc = state.accounts[e.account]?.name ?? e.account;
    const meta = el('div', 'meta', `${e.date} ・ ${acc}`);
    if (e.status === 'provisional') {
      meta.append(' ');
      meta.append(el('span', 'badge', '速報・明細待ち'));
    }
    card.append(meta);

    const guess = e.category ?? M.guessCategory(e.merchant, state.rules);
    const chips = el('div', 'chips');
    chipRow(chips, cats, guess, (v) => confirmCategory(e, v));
    card.append(chips);
    box.append(card);
  }
}

// カテゴリを確定する。追記のみなので、元の行を supersede する新しい行を足す。
async function confirmCategory(entry, category) {
  const next = {
    ...entry,
    id: M.ulid(),
    ts: M.nowTs(),
    category,
    status: entry.status === 'provisional' ? 'provisional' : 'confirmed',
    supersedes: entry.id,
  };
  if (entry.merchant) {
    M.learnRule(state.rules, entry.merchant, category);
    if (navigator.onLine && S.config.ready) {
      S.saveJson('rules.json', state.rules, `学習: ${entry.merchant} → ${category}`).catch(
        () => {}
      );
    }
  }
  state.entries.push(next);
  recompute();
  saveCache();
  const res = await S.record([next]);
  banner(res.sent ? 'カテゴリを設定しました' : `設定しました（未送信: ${res.error}）`,
    res.sent ? 'ok' : 'warn');
  renderInbox();
}

// --- 設定 -------------------------------------------------------------------
async function renderSettings() {
  const c = S.config.get();
  $('cfg-owner').value = c.owner ?? 'tkikukawa';
  $('cfg-repo').value = c.repo ?? 'kakeibo-data';
  $('cfg-token').value = c.token ?? '';
  $('cfg-outbox').textContent = `未送信 ${await S.outbox.count()} 件`;
}

$('cfg-save').onclick = async () => {
  S.config.set({
    owner: $('cfg-owner').value.trim(),
    repo: $('cfg-repo').value.trim(),
    token: $('cfg-token').value.trim(),
  });
  const out = $('cfg-result');
  out.textContent = '確認中…';
  out.style.color = 'var(--muted)';
  const ok = await sync();
  out.textContent = ok ? '接続できました' : '接続できません。上のエラーを確認してください';
  out.style.color = ok ? 'var(--accent)' : 'var(--danger)';
  if (ok) banner('接続しました', 'ok');
};

$('cfg-flush').onclick = async () => {
  try {
    const { sent } = await S.flush();
    banner(sent ? `${sent} 件を送信しました` : '未送信はありません', 'ok');
    await sync({ quiet: true });
    renderSettings();
  } catch (err) {
    banner(err.message, 'err', 6000);
  }
};

$('cfg-forget').onclick = () => {
  if (!confirm('この端末から PAT を消します。よろしいですか')) return;
  S.config.set({ token: '' });
  $('cfg-token').value = '';
  banner('PAT を消しました', 'ok');
};

// --- 起動 -------------------------------------------------------------------
window.addEventListener('online', () => sync({ quiet: true }).then(renderHome));
window.addEventListener('offline', renderHome);

(async function boot() {
  const cached = loadCache();
  if (cached) show('home');
  if (!S.config.ready) {
    show('settings');
    banner('まず PAT を設定してください', 'warn', 0);
    return;
  }
  const ok = await sync();
  show('home');
  if (!ok && !cached) banner('データを読み込めませんでした', 'err', 6000);
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
