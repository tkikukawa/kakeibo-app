import * as M from './model.js';
import * as S from './store.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// 画面が古いままかを切り分けられるよう、設定画面に出す。
// アプリ本体を変えたら sw.js の VERSION と一緒に上げること。
const APP_VERSION = '2026-08-13b';

const CACHE = 'kakeibo.cache';
const state = { accounts: {}, categories: {}, rules: [], entries: [], balances: {} };

// --- 画面切り替え -----------------------------------------------------------
const VIEWS = ['home', 'record', 'count', 'inbox', 'history', 'settings'];
function show(name) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  window.scrollTo(0, 0);
  if (name === 'record') renderRecord();
  if (name === 'count') renderCount();
  if (name === 'inbox') renderInbox();
  if (name === 'history') renderHistory();
  if (name === 'settings') renderSettings();
  if (name === 'home') renderHome();
  // 金額をすぐ打てるよう、数字キーボードを開いておく
  if (name === 'record') $('rec-amount').focus();
  if (name === 'count') $('count-actual').focus();
}
// クリックは要素に直接ぶら下げず、document で受けて振り分ける。
// HTML と JS の版が食い違っても、少なくとも「押しても無反応」にはならない。
const ACTIONS = {
  'toggle-balance'() {
    const shown = localStorage.getItem('kakeibo.showBalance') === '1';
    localStorage.setItem('kakeibo.showBalance', shown ? '0' : '1');
    renderHome();
  },
  // 古い版が残ってボタンが効かなくなったときの自力復旧手段。
  // 記録データは GitHub にあるので、これで消えるのは画面のキャッシュだけ。
  async 'hard-reload'() {
    banner('最新版を取得しています…', 'warn', 0);
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {
      /* 使えない環境でもリロードは試す */
    }
    location.reload();
  },
};
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) return show(go.dataset.go);
  const act = e.target.closest('[data-action]');
  if (act) {
    const fn = ACTIONS[act.dataset.action];
    if (fn) fn(act);
    else banner('この画面は古い版です。一度閉じて開き直してください', 'warn', 6000);
  }
});

// 送信中はボタンを止める。通信が遅いと二度押しされ、同じ記録が2回書かれる。
// model.js 側でも重複した訂正は弾くが、そもそも作らせないのが本筋。
function once(btn, fn) {
  return async (...args) => {
    if (btn.disabled) return;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '送信中…';
    try {
      await fn(...args);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };
}

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

  // 残高は既定で隠す。人前で開いても金額が見えないようにするため。
  const shown = localStorage.getItem('kakeibo.showBalance') === '1';
  $('home-balance-wrap').hidden = !shown;
  $('home-reveal').textContent = shown ? '隠す' : '表示する';
  $('home-reveal').setAttribute('aria-pressed', String(shown));
  if (!shown) {
    refreshStatus();
    return;
  }

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

// --- 記録の履歴・修正 -------------------------------------------------------
// 追記のみを保つため、修正は「新しい行が古い行を無効にする」形で行う。
// 元の記録は消えず、Git 履歴にも残る。
function renderHistory() {
  const box = $('history-list');
  box.replaceChildren();
  const items = M.sortEntries(state.live ?? []).slice(-40).reverse();
  if (items.length === 0) {
    box.append(el('p', 'empty', 'まだ記録がありません'));
    return;
  }
  const KIND = { expense: '支出', income: '収入', transfer: '振替', count: '照合' };
  for (const e of items) {
    const btn = el('button', 'hist');
    const row = el('div', 'row');
    const acc = state.accounts[e.account]?.name ?? e.account;
    const title =
      e.kind === 'transfer'
        ? `${acc} → ${state.accounts[e.counter_account]?.name ?? e.counter_account}`
        : e.merchant || state.categories[e.category]?.name || acc;
    row.append(el('span', 'name', title));
    row.append(el('span', 'amt', M.yen(e.amount)));
    btn.append(row);
    const cat = e.category ? ` ・ ${state.categories[e.category]?.name ?? e.category}` : '';
    btn.append(el('div', 'meta', `${e.date} ・ ${KIND[e.kind] ?? e.kind} ・ ${acc}${cat}`));
    btn.onclick = () => openEditor(e, btn);
    box.append(btn);
  }
}

function openEditor(entry, anchor) {
  document.querySelectorAll('.edit').forEach((n) => n.remove());
  const panel = el('div', 'edit');

  const label = el('div', 'muted small', '正しい金額に直す');
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.value = String(entry.amount);
  panel.append(label, input);

  const actions = el('div', 'actions2');
  const save = el('button', 'primary', '金額を直す');
  const del = el('button', 'danger', 'この記録を取り消す');
  del.style.margin = '0';
  actions.append(save, del);
  panel.append(actions);

  save.onclick = once(save, async () => {
    const amount = parseInt((input.value || '').replace(/[^0-9]/g, ''), 10);
    if (!amount) return banner('金額を入力してください', 'err');
    if (amount === entry.amount) return banner('金額が変わっていません', 'warn');
    await amend(
      { ...entry, id: M.ulid(), ts: M.nowTs(), amount, supersedes: entry.id },
      `${M.yen(entry.amount)} → ${M.yen(amount)} に直しました`
    );
  });
  del.onclick = once(del, async () => {
    if (!confirm(`${M.yen(entry.amount)} の記録を取り消します。よろしいですか`)) return;
    await amend(
      {
        id: M.ulid(),
        ts: M.nowTs(),
        date: entry.date,
        kind: 'void',
        amount: 0,
        account: entry.account,
        status: 'confirmed',
        source: 'manual',
        supersedes: entry.id,
      },
      '記録を取り消しました'
    );
  });

  anchor.after(panel);
  input.focus();
  input.select();
}

async function amend(entry, okMsg) {
  state.entries.push(entry);
  recompute();
  saveCache();
  const res = await S.record([entry]);
  banner(res.sent ? okMsg : `${okMsg}（未送信: ${res.error}）`, res.sent ? 'ok' : 'warn');
  renderHistory();
}

// --- 記録する ---------------------------------------------------------------
let rec = { kind: 'expense', account: null, counter: null, category: null };

const KINDS = [
  ['expense', '支出'],
  ['income', '収入'],
  ['transfer', '振替'],
];

// 収入用のカテゴリは id が income_ で始まるものと決めている。
const isIncomeCat = (id) => id.startsWith('income_');
function categoriesFor(kind) {
  return Object.entries(state.categories)
    .filter(([id, c]) => !c.system && (kind === 'income') === isIncomeCat(id))
    .map(([id, c]) => [id, c.name]);
}

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
  const { kind } = rec;
  const isTransfer = kind === 'transfer';

  // 前回選んだ支払い手段を覚えておく。毎日同じ口座を使うことが多いので、
  // これだけで1タップ減る。
  if (!rec.account) rec.account = localStorage.getItem(`kakeibo.lastAcct.${kind}`);
  if (rec.account && !state.accounts[rec.account]) rec.account = null;

  chipRow($('rec-kinds'), KINDS, kind, (v) => {
    if (rec.kind === v) return;
    rec = { kind: v, account: null, counter: null, category: null };
    renderRecord();
  });

  const accounts = Object.entries(state.accounts).map(([id, a]) => [id, a.name]);
  $('rec-account-label').textContent =
    kind === 'expense' ? '支払い手段' : kind === 'income' ? '入金先' : '出金元';
  chipRow($('rec-accounts'), accounts, rec.account, (v) => {
    rec.account = v;
    if (rec.counter === v) rec.counter = null;
    renderRecord();
  });

  $('rec-counter-wrap').hidden = !isTransfer;
  if (isTransfer) {
    chipRow(
      $('rec-counter'),
      accounts.filter(([id]) => id !== rec.account),
      rec.counter,
      (v) => {
        rec.counter = v;
        renderRecord();
      }
    );
  }

  $('rec-category-wrap').hidden = isTransfer;
  if (!isTransfer) {
    chipRow($('rec-categories'), categoriesFor(kind), rec.category, (v) => {
      rec.category = rec.category === v ? null : v;
      renderRecord();
    });
  }

  $('rec-merchant-wrap').hidden = isTransfer;
  $('rec-merchant-label').textContent = kind === 'income' ? '内容' : '店名';
  $('rec-merchant').placeholder = kind === 'income' ? '給与' : 'ローソン';
  $('rec-title').textContent = { expense: '支出', income: '収入', transfer: '振替' }[kind];

  const acc = state.accounts[rec.account];
  let note;
  if (isTransfer) {
    note = !rec.account
      ? '出金元を選んでください'
      : !rec.counter
        ? '入金先を選んでください'
        : `${acc.name} → ${state.accounts[rec.counter].name}。総資産は変わりません`;
  } else if (!acc) {
    note = kind === 'income' ? '入金先を選んでください' : '支払い手段を選んでください';
  } else if (kind === 'income') {
    note = `${acc.name} に入金として記録します`;
  } else {
    note =
      acc.type === 'cash'
        ? '現金の支出として確定します'
        : '速報として記録します。後日CSVの明細と自動で統合されます';
  }
  $('rec-note').textContent = note;
}

$('rec-save').onclick = once($('rec-save'), async () => {
  const amount = parseInt(($('rec-amount').value || '').replace(/[^0-9]/g, ''), 10);
  if (!amount) return banner('金額を入力してください', 'err');
  if (!rec.account) return banner('口座を選んでください', 'err');
  if (rec.kind === 'transfer' && !rec.counter) return banner('入金先を選んでください', 'err');

  const entry = {
    id: M.ulid(),
    ts: M.nowTs(),
    date: M.today(),
    kind: rec.kind,
    amount,
    account: rec.account,
    source: 'manual',
  };

  if (rec.kind === 'transfer') {
    // 振替は総資産を動かさないので、カテゴリも突き合わせも要らない
    entry.counter_account = rec.counter;
    entry.status = 'confirmed';
  } else {
    const merchant = $('rec-merchant').value.trim() || null;
    const acc = state.accounts[rec.account];
    const category = rec.category ?? M.guessCategory(merchant, state.rules);
    // 現金は明細が後から来ないのでその場で確定。それ以外は速報として明細を待つ
    entry.status =
      acc.type === 'cash' ? (category ? 'confirmed' : 'pending') : 'provisional';
    if (category) entry.category = category;
    if (merchant) entry.merchant = merchant;
  }

  const label = { expense: '支出', income: '収入', transfer: '振替' }[rec.kind];
  localStorage.setItem(`kakeibo.lastAcct.${rec.kind}`, rec.account);
  $('rec-amount').value = '';
  $('rec-merchant').value = '';
  rec = { kind: rec.kind, account: null, counter: null, category: null };
  await commit([entry], `${label} ${M.yen(amount)} を記録しました`);
});

// --- 財布を数える -----------------------------------------------------------
let countAccount = 'cash';

// 口座ごとに「何を見て入力するのか」が違うので、文言を変える。
const COUNT_UI = {
  cash: {
    title: '財布を数える',
    label: '実際に数えた額',
    openLabel: 'いまの財布の中身',
    hint: '財布の中身をすべて数えてください',
  },
  bank: {
    title: '残高を照合',
    label: '銀行アプリの残高',
    openLabel: 'いまの残高',
    hint: '銀行アプリで残高を確認してください',
  },
  prepaid: {
    title: '残高を照合',
    label: 'アプリの残高',
    openLabel: 'いまの残高',
    hint: 'PayPay アプリなどで残高を確認してください',
  },
  credit: {
    title: '未払額を照合',
    label: '未払額',
    openLabel: 'いまの未払額',
    hint: 'カード会社の「利用限度額 − ご利用可能額」を入れてください。締め日のズレで合わないことがあるので、無理に照合しなくて構いません',
  },
};

const countUi = () => COUNT_UI[state.accounts[countAccount]?.type] ?? COUNT_UI.cash;
const isCreditCount = () => state.accounts[countAccount]?.type === 'credit';

// その口座に記録が1件も無ければ、これは期首残高の設定。
// 差額を「不明な増加」ではなく「期首残高」として計上し、収入統計を汚さない。
const isOpening = () =>
  !(state.live ?? []).some(
    (e) => e.account === countAccount || e.counter_account === countAccount
  );

// credit は残高が負なので、入力も表示も「未払額」として正の数で扱う
const predictedRaw = () => state.balances[countAccount] ?? 0;
const predictedShown = () => (isCreditCount() ? -predictedRaw() : predictedRaw());

function renderCount() {
  const tracked = Object.entries(state.accounts)
    .filter(([, a]) => M.isTracked(a))
    .map(([id, a]) => [id, a.name]);
  if (!state.accounts[countAccount]) countAccount = tracked[0]?.[0] ?? 'cash';

  chipRow($('count-accounts'), tracked, countAccount, (v) => {
    countAccount = v;
    $('count-actual').value = '';
    renderCount();
  });

  const ui = countUi();
  const opening = isOpening();
  $('count-title').textContent = opening ? '期首残高を入れる' : ui.title;
  $('count-label').textContent = opening ? ui.openLabel : ui.label;
  $('count-predicted').textContent = M.yen(predictedShown());
  updateDiff();
}

function updateDiff() {
  const raw = ($('count-actual').value || '').replace(/[^0-9]/g, '');
  const box = $('count-diff');
  const opening = isOpening();
  if (!raw) {
    box.className = 'diff';
    box.textContent = opening
      ? 'この口座の最初の記録です。いまの残高を入れると、そこを出発点にします'
      : countUi().hint;
    return;
  }
  const actual = isCreditCount() ? -parseInt(raw, 10) : parseInt(raw, 10);
  const diff = predictedRaw() - actual;
  box.className = diff === 0 ? 'diff' : 'diff on';
  box.textContent = opening
    ? `期首残高として ${M.yen(Math.abs(actual))} を設定します`
    : diff === 0
      ? 'ぴったり合っています'
      : diff > 0
        ? `${M.yen(diff)} 分の記録漏れ → 使途不明として計上します`
        : `${M.yen(-diff)} 多い → 不明な増加として計上します`;
}
$('count-actual').addEventListener('input', updateDiff);

$('count-save').onclick = once($('count-save'), async () => {
  const raw = ($('count-actual').value || '').replace(/[^0-9]/g, '');
  if (raw === '') return banner('金額を入力してください', 'err');
  const actual = isCreditCount() ? -parseInt(raw, 10) : parseInt(raw, 10);
  const diff = predictedRaw() - actual;
  const name = state.accounts[countAccount].name;
  const base = { ts: M.nowTs(), date: M.today(), account: countAccount, source: 'manual' };

  // count は実残高の宣言。残高そのものは動かさず、差額を別の行で計上する。
  // 何が起きたかがログだけで追えるようにするため、2行に分けている。
  const entries = [
    { ...base, id: M.ulid(), kind: 'count', amount: Math.abs(actual), status: 'confirmed' },
  ];
  const opening = isOpening();
  if (diff !== 0) {
    entries.push({
      ...base,
      id: M.ulid(),
      kind: diff > 0 ? 'expense' : 'income',
      amount: Math.abs(diff),
      category: opening ? 'opening' : diff > 0 ? 'unknown' : 'unknown_income',
      status: 'confirmed',
      source: 'reconcile',
      memo: opening ? `${name}の期首残高` : `${name}の照合による調整`,
    });
  }
  $('count-actual').value = '';
  await commit(
    entries,
    opening
      ? `${name} の期首残高を設定しました`
      : diff === 0
        ? `${name}: ぴったり合っています`
        : `${name} を照合しました`
  );
});

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
  $('cfg-version').textContent = `アプリの版: ${APP_VERSION}`;
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
