// 会計モデル。project.py と同じ符号規約を実装する。
// ここが食い違うと画面の数字と分析の数字がズレるので、変更するときは必ず両方直すこと。
//
//   expense  : account         -= amount
//   income   : account         += amount
//   transfer : account         -= amount,  counter_account += amount
//   count    : 作用なし（実残高の宣言）
//   void     : supersedes 対象を無効化
//
// credit 口座の残高は常に 0 以下で、絶対値が未払額。
// 総資産は全口座の単純合計でよい（credit が負なので自動で引かれる）。

// Suica の charge_as_expense のように、チャージ時点で支出計上して
// 利用履歴を追わない口座は残高を持たない。総資産からも外す。
export function isTracked(account) {
  return account.mode !== 'charge_as_expense';
}

// 訂正・取り消しを適用して、生きているエントリだけを返す。
//
// supersedes で指された id は死ぬ。訂正が連鎖しても最新だけが残る。
//
// 同じ行を2回訂正した場合（保存ボタンの連打や、遅い通信での二度押しで起きる）、
// 訂正が両方とも生き残ると金額が二重に計上される。そうならないよう、
// 同じ id を指す訂正が複数あるときは最後の1つだけを採用する。
export function liveEntries(entries) {
  const superseded = new Set();
  const winner = new Map(); // supersedes 先 → 採用する訂正
  const isNewer = (a, b) => (a.ts === b.ts ? a.id > b.id : a.ts > b.ts);

  for (const e of entries) {
    if (!e.supersedes) continue;
    superseded.add(e.supersedes);
    const prev = winner.get(e.supersedes);
    if (!prev || isNewer(e, prev)) winner.set(e.supersedes, e);
  }

  return entries.filter((e) => {
    if (superseded.has(e.id)) return false; // 訂正された
    if (e.kind === 'void') return false; // 取り消しそのものは残高に効かない
    if (e.supersedes && winner.get(e.supersedes).id !== e.id) return false; // 重複した訂正
    return true;
  });
}

export function sortEntries(entries) {
  return [...entries].sort((a, b) =>
    a.date === b.date ? a.ts.localeCompare(b.ts) : a.date.localeCompare(b.date)
  );
}

export function computeBalances(accounts, entries) {
  const balances = {};
  for (const [id, acc] of Object.entries(accounts)) {
    if (isTracked(acc)) balances[id] = acc.opening ?? 0;
  }
  const move = (id, delta) => {
    if (!accounts[id]) throw new Error(`未知の口座: ${id}`);
    if (isTracked(accounts[id])) balances[id] += delta;
  };
  for (const e of entries) {
    if (e.kind === 'expense') move(e.account, -e.amount);
    else if (e.kind === 'income') move(e.account, e.amount);
    else if (e.kind === 'transfer') {
      move(e.account, -e.amount);
      move(e.counter_account, e.amount);
    } else if (e.kind === 'count') {
      /* 残高には作用しない */
    } else throw new Error(`未知の kind: ${e.kind}`);
  }
  return balances;
}

export function netWorth(balances) {
  return Object.values(balances).reduce((a, b) => a + b, 0);
}

// 総資産 == 期首合計 + 収入合計 - 支出合計 が成り立つか。
// 振替は総資産を動かさないのでこの等式は必ず成り立つ。破れていれば
// 振替の counter_account が抜けている等の設定ミスがある。
export function checkInvariant(accounts, entries, balances) {
  const opening = Object.values(accounts)
    .filter(isTracked)
    .reduce((s, a) => s + (a.opening ?? 0), 0);
  const sum = (kind) =>
    entries.filter((e) => e.kind === kind).reduce((s, e) => s + e.amount, 0);
  const expected = opening + sum('income') - sum('expense');
  const actual = netWorth(balances);
  return actual === expected ? null : { expected, actual };
}

export function spendingByCategory(entries, { from, to } = {}) {
  const totals = {};
  for (const e of entries) {
    if (e.kind !== 'expense') continue;
    if (from && e.date < from) continue;
    if (to && e.date > to) continue;
    const cat = e.category || '(未分類)';
    totals[cat] = (totals[cat] ?? 0) + e.amount;
  }
  return Object.fromEntries(Object.entries(totals).sort((a, b) => b[1] - a[1]));
}

// prefix が '2026-08' なら月、'2026-08-13' ならその日の支出合計になる
export function monthTotal(entries, prefix) {
  return entries
    .filter((e) => e.kind === 'expense' && e.date.startsWith(prefix))
    .reduce((s, e) => s + e.amount, 0);
}

// 未処理トレイに出すもの。速報と、カテゴリ未確定の取込明細。
export function inbox(entries) {
  return entries.filter(
    (e) =>
      e.kind !== 'count' &&
      (e.status === 'provisional' || (e.status === 'pending' && !e.category))
  );
}

// 手入力の速報と、後から来た取込明細を突き合わせる。
// 同じ口座・金額完全一致・日付±3日 を条件にする。ズレていれば
// 統合されず両方残るので、打ち間違いに気づける。
export function matchProvisional(provisional, imported) {
  if (provisional.account !== imported.account) return false;
  if (provisional.amount !== imported.amount) return false;
  const days = Math.abs(
    (new Date(imported.date) - new Date(provisional.date)) / 86400000
  );
  return days <= 3;
}

// 店名からカテゴリを推定する。長いパターン優先 → 実績の多い順。
export function guessCategory(merchant, rules) {
  if (!merchant) return null;
  const hit = [...rules]
    .sort((a, b) => b.match.length - a.match.length || (b.hits ?? 0) - (a.hits ?? 0))
    .find((r) =>
      r.regex ? new RegExp(r.match).test(merchant) : merchant.includes(r.match)
    );
  return hit ? hit.category : null;
}

export function learnRule(rules, merchant, category) {
  if (!merchant || !category) return rules;
  const existing = rules.find((r) => !r.regex && r.match === merchant);
  const today = new Date().toISOString().slice(0, 10);
  if (existing) {
    existing.category = category;
    existing.hits = (existing.hits ?? 0) + 1;
    existing.updated = today;
  } else {
    rules.push({ match: merchant, category, hits: 1, updated: today });
  }
  return rules;
}

// ULID。時刻順にソートでき、端末をまたいでも衝突しない。
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid(now = Date.now()) {
  let time = '';
  for (let i = 9; i >= 0; i--) {
    time = B32[now % 32] + time;
    now = Math.floor(now / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(16));
  return time + [...rand].map((b) => B32[b % 32]).join('');
}

export const yen = (n) => `¥${n.toLocaleString('ja-JP')}`;
export const today = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
export const nowTs = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
  );
};
