import * as M from './model.js?v=2026-08-14a';
import * as S from './store.js?v=2026-08-14a';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// アプリ本体を変えたら、この3つを必ず一緒に上げること。
//   app.js の APP_VERSION / index.html の meta[app-version] / sw.js の VERSION
const APP_VERSION = '2026-08-14a';

// HTML と JS が別々にキャッシュされ、新旧が混ざることがある。
// そうなるとボタンが無反応になったり画面が空になったりして原因が分かりにくい。
// 版が食い違っていたら、黙って直す。ループしないよう1回だけ。
function healVersionSkew() {
  const html = document.querySelector('meta[name=app-version]')?.content;
  if (html === APP_VERSION) {
    sessionStorage.removeItem('kakeibo.healed');
    return false;
  }
  if (sessionStorage.getItem('kakeibo.healed')) {
    // 直しても揃わない。これ以上リロードしても無駄なので手動操作を促す
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<div class="banner err">版が揃っていません。設定から「アプリを最新にする」を試してください</div>'
    );
    return false;
  }
  sessionStorage.setItem('kakeibo.healed', '1');
  (async () => {
    await purgeCaches();
    location.reload();
  })();
  return true;
}

// Service Worker のキャッシュだけ消しても足りない。GitHub Pages は
// Cache-Control: max-age=600 を返すので、ブラウザ自身の HTTP キャッシュが
// 10分間は古いファイルを返し続ける。cache:'reload' で取り直して上書きする。
const SHELL = ['./', 'index.html', 'sw.js'];
async function purgeCaches() {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    /* 使えない環境でも下の取り直しは試す */
  }
  await Promise.all(
    SHELL.map((f) => fetch(f, { cache: 'reload' }).catch(() => {}))
  );
}

const CACHE = 'kakeibo.cache';
const state = { accounts: {}, categories: {}, rules: [], entries: [], balances: {} };

// --- 画面切り替え -----------------------------------------------------------
const VIEWS = ['home', 'record', 'count', 'update', 'summary', 'inbox', 'history', 'settings'];
function show(name) {
  // 要素が欠けていても止まらないようにする。1つ足りないだけで
  // 画面遷移が丸ごと死ぬと、原因が分からない不具合になる。
  for (const v of VIEWS) {
    const el = $(`view-${v}`);
    if (el) el.hidden = v !== name;
  }
  window.scrollTo(0, 0);
  if (name === 'record') renderRecord();
  if (name === 'count') renderCount();
  if (name === 'update') renderUpdate();
  if (name === 'summary') renderSummary();
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
    sessionStorage.removeItem('kakeibo.healed');
    await purgeCaches();
    location.reload();
  },
  'month-prev'() {
    summaryMonth = shiftMonth(summaryMonth ?? M.today().slice(0, 7), -1);
    renderSummary();
  },
  'month-next'() {
    const next = shiftMonth(summaryMonth ?? M.today().slice(0, 7), 1);
    // 未来の月には行かせない。空の画面を見せても意味がない
    if (next > M.today().slice(0, 7)) return;
    summaryMonth = next;
    renderSummary();
  },
  'add-income'() {
    addIncomeRow()?.querySelector('input').focus();
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

  const today = M.today();
  $('home-today').textContent = M.yen(M.monthTotal(state.live ?? [], today));
  $('home-month').textContent = M.yen(M.monthTotal(state.live ?? [], today.slice(0, 7)));
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
    // 「振替」だけでは何を入れる場面か伝わらないので、具体例を出す
    note = !rec.account
      ? 'ATMで下ろした・チャージした、など口座間のお金の移動。出金元を選んでください'
      : !rec.counter
        ? '入金先を選んでください（ATM出金なら「現金」）'
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

// その口座をまだ一度も照合していなければ、これは期首残高の設定。
//
// 「記録が1件も無いこと」を条件にすると、支出だけ先に記録していた口座で
// 初回の照合が普通の照合として扱われ、本来の期首残高が丸ごと
// 「不明な増加」に化ける。基準を決めるのは最初の照合なので、そこで判定する。
const isOpening = () =>
  !(state.live ?? []).some((e) => e.kind === 'count' && e.account === countAccount);

// credit は残高が負なので、入力も表示も「未払額」として正の数で扱う
const predictedRaw = () => state.balances[countAccount] ?? 0;
const predictedShown = () => (isCreditCount() ? -predictedRaw() : predictedRaw());

function renderCount() {
  // この画面は現金専用。銀行やカードは「口座情報を更新」でまとめて扱う。
  // 毎日やるのは現金だけなので、選ばせるだけ手間になる。
  countAccount = 'cash';
  const ui = countUi();
  const opening = isOpening();
  $('count-title').textContent = opening ? '最初の残高を入れる' : ui.title;
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
    ? `最初の残高として ${M.yen(Math.abs(actual))} を設定します`
    : diff === 0
      ? 'ぴったり合っています'
      : diff > 0
        ? `${M.yen(diff)} 分の記録漏れ → 使途不明として計上します`
        : // 予測より多いのは、たいていATMで下ろしたのを記録していないから。
          // 振替として入れないと支出がその分だけ過大になるので、ここで促す。
          `${M.yen(-diff)} 多い。ATMで下ろした分なら、先に「支出を記録 → 振替」で` +
          '入れてください。そうでなければ不明な増加として計上します';
}
$('count-actual').addEventListener('input', updateDiff);

// 照合1件分のエントリを組み立てる。1口座ずつの画面と一括更新画面で共有する。
// 期首か通常かの分岐が2箇所に散ると必ず食い違うので、ここ1本に集める。
//
// count は実残高の宣言で、残高そのものは動かさない。差額は別の行として
// 計上する。2行に分けておくと、何が起きたかがログだけで追える。
function reconcileEntries(accountId, entered, balances = state.balances, month = null) {
  const acc = state.accounts[accountId];
  const isCredit = acc.type === 'credit';
  const actual = isCredit ? -entered : entered;
  const diff = (balances[accountId] ?? 0) - actual;
  const opening = !(state.live ?? []).some(
    (e) => e.kind === 'count' && e.account === accountId
  );
  const base = {
    ts: M.nowTs(),
    date: dateForMonth(month),
    account: accountId,
    source: 'manual',
  };
  // 何月分かを明示しておく。8月に7月分の請求を記入することがあるため。
  if (month) base.month = month;

  const entries = [
    { ...base, id: M.ulid(), kind: 'count', amount: Math.abs(actual), status: 'confirmed' },
  ];
  if (diff !== 0) {
    entries.push({
      ...base,
      id: M.ulid(),
      kind: diff > 0 ? 'expense' : 'income',
      amount: Math.abs(diff),
      category: opening ? 'opening' : diff > 0 ? 'unknown' : 'unknown_income',
      status: 'confirmed',
      source: 'reconcile',
      memo: opening ? `${acc.name}の最初の残高` : `${acc.name}の照合による調整`,
    });
  }
  return { entries, diff, opening, name: acc.name };
}

$('count-save').onclick = once($('count-save'), async () => {
  const raw = ($('count-actual').value || '').replace(/[^0-9]/g, '');
  if (raw === '') return banner('金額を入力してください', 'err');
  const { entries, diff, opening, name } = reconcileEntries(countAccount, parseInt(raw, 10));
  $('count-actual').value = '';
  await commit(
    entries,
    opening
      ? `${name} の最初の残高を設定しました`
      : diff === 0
        ? `${name}: ぴったり合っています`
        : `${name} を照合しました`
  );
});

// 「◯月分」として記録するときの日付。
// 過去の月を選んだらその月の末日にする。そうしないと7月分の請求が
// 8月の支出として集計されてしまう。今月ならそのまま今日。
function dateForMonth(month) {
  const today = M.today();
  if (!month || month === today.slice(0, 7)) return today;
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate(); // 翌月0日 = 当月末日
  return `${month}-${String(last).padStart(2, '0')}`;
}

// その口座の「◯月分」をすでに記録したか。
// カードは締め日が月1回なので、月ごとに1回だけ記入できるようにする。
function doneForMonth(accountId, month) {
  return (state.live ?? []).some(
    (e) => e.kind === 'count' && e.account === accountId && M.entryMonth(e) === month
  );
}

// 月の選択肢。今月から遡って6か月分。
function monthOptions() {
  const [y, m] = M.today().slice(0, 7).split('-').map(Number);
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(y, m - 1 - i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
}

// --- 口座情報を更新（まとめて照合）-----------------------------------------
// 現金だけ入れてもいいし、全部入れてもいい。空欄の口座は触らない。
// 全部まとめて入れると、口座間の移動(ATM出金など)が自動的に相殺される。
function renderUpdate() {
  const box = $('update-list');
  box.replaceChildren();
  // 現金を先頭に。普段は現金だけ触ることが多いため。
  const accounts = Object.entries(state.accounts)
    .filter(([, a]) => M.isTracked(a))
    .sort(([, a], [, b]) => (a.type === 'cash' ? -1 : b.type === 'cash' ? 1 : 0));

  for (const [id, acc] of accounts) {
    const isCredit = acc.type === 'credit';
    const row = el('div', 'acct');
    const head = el('div', 'row');
    head.append(el('span', 'name', acc.name));
    head.append(
      el('span', 'meta', isCredit ? '未払額' : COUNT_UI[acc.type]?.label ?? '残高')
    );
    row.append(head);

    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.dataset.account = id;
    input.placeholder = '空欄なら変更しません';

    const note = el('div', 'meta acct-note');

    // カードは月に1回しか記入しない。締め日の途中で照合すると、支出でも
    // 何でもない差額が「使途不明」として積まれてしまう。
    // どの月の請求かを選べるようにし、その月がすでに埋まっていれば閉じる。
    let monthSel = null;
    if (isCredit) {
      monthSel = document.createElement('select');
      for (const m of monthOptions()) {
        const o = document.createElement('option');
        o.value = m;
        const [y, mm] = m.split('-');
        o.textContent = `${y}年${Number(mm)}月分`;
        monthSel.append(o);
      }
      input.dataset.month = monthSel.value;
      row.append(monthSel);
    }

    const applyLock = () => {
      if (!isCredit) return;
      input.dataset.month = monthSel.value;
      const taken = doneForMonth(id, monthSel.value);
      input.disabled = taken;
      input.value = taken ? '' : input.value;
      input.placeholder = taken ? '記入済み' : '空欄なら変更しません';
      note.textContent = taken
        ? 'この月はすでに記入済みです。直すなら「記録の履歴・修正」から'
        : '';
    };
    if (monthSel) monthSel.addEventListener('change', applyLock);

    row.append(input, note);

    input.addEventListener('input', () => {
      const raw = input.value.replace(/[^0-9]/g, '');
      if (!raw) return (note.textContent = '');
      const { diff, opening } = reconcileEntries(
        id,
        parseInt(raw, 10),
        state.balances,
        input.dataset.month ?? null
      );
      note.textContent = opening
        ? '最初の残高として設定します'
        : diff === 0
          ? 'ぴったり合っています'
          : diff > 0
            ? `${M.yen(diff)} の記録漏れ → 使途不明`
            : `${M.yen(-diff)} 多い → 不明な増加`;
    });

    applyLock();
    box.append(row);
  }

  $('update-income-list').replaceChildren();
  addIncomeRow();
}

// 収入の入金先の候補。銀行があれば銀行だけに絞る（給与の入り先はほぼ銀行）。
function incomeChoices() {
  const accounts = Object.entries(state.accounts).filter(([, a]) => M.isTracked(a));
  const banks = accounts.filter(([, a]) => a.type === 'bank');
  return (banks.length ? banks : accounts).map(([id, a]) => [id, a.name]);
}

// 収入は月に複数あることがある（給与・返金・立替の精算など）。
// 1行に固定すると合計を頭で足す手間が出るので、行を足せるようにする。
function addIncomeRow() {
  const choices = incomeChoices();
  if (choices.length === 0) return;
  const row = el('div', 'acct');
  row.dataset.income = '1';
  row.dataset.account = choices[0][0];

  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.placeholder = '金額';
  input.autocomplete = 'off';

  const chips = el('div', 'chips');
  chips.style.marginTop = '10px';
  const draw = () =>
    chipRow(chips, choices, row.dataset.account, (v) => {
      row.dataset.account = v;
      draw();
    });
  draw();

  row.append(input, chips);
  $('update-income-list').append(row);
  return row;
}

$('update-save').onclick = once($('update-save'), async () => {
  const inputs = [...$('update-list').querySelectorAll('input[data-account]:not(:disabled)')];
  const filled = inputs.filter((i) => i.value.replace(/[^0-9]/g, '') !== '');

  const incomes = [...$('update-income-list').querySelectorAll('[data-income]')]
    .map((row) => ({
      amount: parseInt((row.querySelector('input').value || '').replace(/[^0-9]/g, ''), 10),
      account: row.dataset.account,
    }))
    .filter((x) => x.amount > 0 && x.account);

  if (filled.length === 0 && incomes.length === 0) {
    return banner('1つ以上入力してください', 'err');
  }

  // 収入を先に確定させ、それを反映した残高と実額を突き合わせる。
  //   支出 = 期首 + 収入 − 現在の総資産
  // 収入を後回しにすると、その分が丸ごと「使途不明の支出」に化ける。
  const entries = incomes.map((x) => ({
    id: M.ulid(),
    ts: M.nowTs(),
    date: M.today(),
    kind: 'income',
    amount: x.amount,
    account: x.account,
    category: 'income_salary',
    status: 'confirmed',
    source: 'manual',
  }));
  const balances = M.computeBalances(state.accounts, [...(state.live ?? []), ...entries]);

  for (const input of filled) {
    const value = parseInt(input.value.replace(/[^0-9]/g, ''), 10);
    entries.push(
      ...reconcileEntries(
        input.dataset.account,
        value,
        balances,
        input.dataset.month ?? null
      ).entries
    );
  }

  const partial = filled.length > 0 && filled.length < inputs.length;
  await commit(
    entries,
    partial
      ? `${filled.length}口座を更新しました（一部のみ）`
      : `${filled.length}口座をまとめて更新しました`
  );
});

// --- 集計 -------------------------------------------------------------------
// 出すのは「正確に出せる数字」だけ。カテゴリ内訳は使途不明が大半を占めるが、
// 隠さず出す。割合そのものが「記録がどれだけ雑か」の自己診断になる。
// 推移グラフは比べる相手がいて初めて意味を持つので、2か月たまるまで出さない。
let summaryMonth = null;

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const monthLabel = (m) => `${m.slice(0, 4)}年${Number(m.slice(5, 7))}月`;

function renderSummary() {
  const live = state.live ?? [];
  const thisMonth = M.today().slice(0, 7);
  if (!summaryMonth) summaryMonth = thisMonth;
  $('sum-month').textContent = monthLabel(summaryMonth);

  const { income, expense, net } = M.monthSummary(live, summaryMonth);
  $('sum-expense').textContent = M.yen(expense);
  $('sum-income').textContent = M.yen(income);
  $('sum-expense2').textContent = M.yen(expense);
  $('sum-net').textContent = `${net >= 0 ? '+' : '−'}${M.yen(Math.abs(net))}`;

  // 月末予測。ここが一番その日の行動を変える数字なので上に置く。
  const p = M.pace(live, summaryMonth, M.today());
  $('sum-pace-wrap').hidden = !p;
  if (p) {
    $('sum-pace').textContent =
      `${p.day}日時点。このペースだと月末 ${M.yen(p.projected)}`;
  }

  renderBreakdown(live);
  renderTrend(live);
}

function renderBreakdown(live) {
  const box = $('sum-breakdown');
  box.replaceChildren();
  const totals = M.spendingByCategory(live, {
    from: `${summaryMonth}-01`,
    to: `${summaryMonth}-31`,
  });
  const rows = Object.entries(totals);
  if (rows.length === 0) {
    box.append(el('p', 'empty', 'この月の支出はまだありません'));
    $('sum-unknown').textContent = '';
    return;
  }
  // 大きい順に明るくする。長さと明度で同じことを二重に伝える。
  const shades = ['#ffffff', '#c8c8c8', '#9a9a9a', '#767676', '#5a5a5a', '#454545'];
  const max = rows[0][1];
  const sum = rows.reduce((s, [, v]) => s + v, 0);

  rows.forEach(([cat, amount], i) => {
    const name = state.categories[cat]?.name ?? cat;
    const row = el('div', 'bar');
    const head = el('div', 'row');
    head.append(el('span', null, name));
    head.append(el('span', 'meta', M.yen(amount)));
    const track = el('div', 'track');
    const fill = el('div', 'fill');
    fill.style.width = `${Math.max(2, (amount / max) * 100)}%`;
    fill.style.background = shades[Math.min(i, shades.length - 1)];
    track.append(fill);
    row.append(head, track);
    box.append(row);
  });

  const unknown = (totals.unknown ?? 0) + (totals['(未分類)'] ?? 0);
  $('sum-unknown').textContent = unknown
    ? `使途不明が ${Math.round((unknown / sum) * 100)}%。記録を増やすとここが減ります`
    : '';
}

// 総資産の推移。各月末までの記録だけで残高を出し直す。
function netWorthByMonth(live, months) {
  return months.map((m) => {
    const end = `${m}-31`;
    const upTo = live.filter((e) => e.date <= end);
    try {
      return { month: m, value: M.netWorth(M.computeBalances(state.accounts, upTo)) };
    } catch {
      return { month: m, value: 0 };
    }
  });
}

function renderTrend(live) {
  const box = $('sum-trend');
  box.replaceChildren();
  const months = M.monthsWithData(live);
  if (months.length < 2) {
    box.append(el('h2', null, '推移'));
    box.append(
      el('p', 'muted small', '2か月分の記録がたまると、月ごとの支出と総資産の推移が出ます')
    );
    return;
  }

  const recent = months.slice(-6);
  const totals = M.monthlyTotals(live).filter((t) => recent.includes(t.month));
  const max = Math.max(...totals.map((t) => t.expense), 1);

  box.append(el('h2', null, '月ごとの支出'));
  const chart = el('div', 'bars');
  for (const t of totals) {
    const col = el('div', 'col');
    const bar = el('div', 'colbar');
    bar.style.height = `${Math.max(3, (t.expense / max) * 100)}%`;
    if (t.month === summaryMonth) bar.classList.add('now');
    const label = el('span', 'meta', `${Number(t.month.slice(5, 7))}月`);
    col.append(bar, label);
    col.title = `${monthLabel(t.month)} ${M.yen(t.expense)}`;
    chart.append(col);
  }
  box.append(chart);

  box.append(el('h2', null, '総資産の推移'));
  const series = netWorthByMonth(live, recent);
  const values = series.map((s) => s.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = series.map((s, i) => {
    const x = 8 + (i * 224) / Math.max(series.length - 1, 1);
    const y = 54 - ((s.value - lo) / span) * 42;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 240 62');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '62');
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    `総資産は ${monthLabel(recent[0])} の ${M.yen(values[0])} から ` +
      `${monthLabel(recent.at(-1))} の ${M.yen(values.at(-1))} へ推移`
  );
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', pts.join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', '#ffffff');
  line.setAttribute('stroke-width', '2');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('stroke-linejoin', 'round');
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  const [cx, cy] = pts.at(-1).split(',');
  dot.setAttribute('cx', cx);
  dot.setAttribute('cy', cy);
  dot.setAttribute('r', '4');
  dot.setAttribute('fill', '#ffffff');
  svg.append(line, dot);
  box.append(svg);

  const ends = el('div', 'ends');
  ends.append(el('span', 'meta', `${monthLabel(recent[0])} ${M.yen(values[0])}`));
  ends.append(el('span', 'meta', M.yen(values.at(-1))));
  box.append(ends);
}

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
  if (healVersionSkew()) return; // 入れ直し中。この版では何もしない
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
