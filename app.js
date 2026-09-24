/* Gas Tracker page logic.

   Two independent halves, deliberately kept apart:
     live    — asks the Worker, which asks Costco. Records nothing.
     history — reads data/history.json from this repo, written twice a day by
               the Worker's cron. Never touched by anything the page does. */

const SERIES_COLORS = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6'];
const WORKER = window.GAS_CONFIG.WORKER.replace(/\/$/, '');

const state = {
  stations: [],       // data/stations.json — the tracked set
  history: null,      // data/history.json
  fuel: null,
  days: 30,
  selected: new Set(),
  found: []           // last search results, kept so 关注 can send the full record
};

const $ = (id) => document.getElementById(id);
const money = (v) => (v == null ? '—' : v.toFixed(3));

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 3000);
}

async function getJSON(url) {
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) {
    let detail = `${resp.status} ${resp.statusText}`;
    try { detail = (await resp.json()).error || detail; } catch (_) {}
    throw new Error(detail);
  }
  return resp.json();
}

/** "2026-09-21T18:00Z" -> Date. Safari rejects the minute-precision form. */
const parseStamp = (s) => new Date(s.length === 17 ? s.replace('Z', ':00Z') : s);

function relative(stamp) {
  if (!stamp) return '未知';
  const seconds = (Date.now() - parseStamp(stamp).getTime()) / 1000;
  if (seconds < 90) return '刚刚';
  if (seconds < 5400) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} 小时前`;
  return `${Math.round(seconds / 86400)} 天前`;
}

const labelOf = (s) => (s.city ? `${s.city} #${s.id}` : `#${s.id}`);

function colorOf(stationId) {
  const index = state.stations.findIndex((s) => String(s.id) === String(stationId));
  return `var(${SERIES_COLORS[(index < 0 ? 0 : index) % SERIES_COLORS.length]})`;
}

// --- live -------------------------------------------------------------------

async function loadLive() {
  const ids = state.stations.map((s) => s.id);
  if (ids.length === 0) {
    $('live-cards').innerHTML = '<div class="empty">还没有关注的站。在下面搜邮编，点「关注」加一个。</div>';
    return;
  }
  $('live-cards').innerHTML = state.stations
    .map((s) => `<div class="card"><h3>${labelOf(s)}</h3><div class="sub">读取中…</div></div>`)
    .join('');

  let data;
  try {
    data = await getJSON(`${WORKER}/live?ids=${ids.join(',')}`);
  } catch (err) {
    $('live-cards').innerHTML =
      `<div class="empty">实时价读取失败：${err.message}<br>
       <span style="font-size:12px">Worker 地址：<code>${WORKER}</code></span></div>`;
    return;
  }

  const cheapest = {};
  for (const [id, entry] of Object.entries(data.stations)) {
    for (const [fuel, price] of Object.entries(entry.prices || {})) {
      if (!(fuel in cheapest) || price < cheapest[fuel].price) cheapest[fuel] = { price, id };
    }
  }

  $('live-cards').innerHTML = state.stations.map((s) => {
    const entry = data.stations[String(s.id)] || {};
    if (entry.error) {
      return `<div class="card"><span class="swatch" style="background:${colorOf(s.id)}"></span>
        <button class="unfollow" data-id="${s.id}" title="取消关注">×</button><h3>${labelOf(s)}</h3><div class="sub">${s.address || ''}</div>
        <div class="err">读取失败：${entry.error}</div></div>`;
    }
    const rows = Object.entries(entry.prices || {}).sort().map(([fuel, price]) => {
      const best = cheapest[fuel] && String(cheapest[fuel].id) === String(s.id);
      return `<div class="price-row"><span class="fuel">${fuel}</span>
        <span class="price">${money(price)}</span>
        ${best ? '<span class="cheapest">最低</span>' : ''}</div>`;
    }).join('') || '<div class="sub">暂无挂牌价</div>';
    return `<div class="card"><span class="swatch" style="background:${colorOf(s.id)}"></span>
      <button class="unfollow" data-id="${s.id}" title="取消关注">×</button><h3>${labelOf(s)}</h3><div class="sub">${s.address || ''}</div>${rows}</div>`;
  }).join('');

  $('live-note').innerHTML =
    `每次查询都直接问 Costco，<strong>不写入数据库</strong>，不影响下面的历史曲线。` +
    `<span style="margin-left:8px">更新于 ${relative(data.at)}</span>`;
}

// --- following (edits data/stations.json through the Worker) ----------------

const KEY_STORE = 'gas-tracker.collect-key';

function storedKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch (_) { return ''; }
}

function rememberKey(value) {
  try {
    if (value) localStorage.setItem(KEY_STORE, value);
    else localStorage.removeItem(KEY_STORE);
  } catch (_) {}
}

/** POST or DELETE /stations. Asks for the Worker's COLLECT_KEY once and keeps it. */
async function editStations(method, { station, id }) {
  let key = storedKey();
  if (!key) {
    key = (window.prompt('关注/取消关注会改动采集名单，需要 Worker 的 COLLECT_KEY：') || '').trim();
    if (!key) throw new Error('已取消');
  }
  const resp = await fetch(
    method === 'DELETE' ? `${WORKER}/stations?id=${encodeURIComponent(id)}` : `${WORKER}/stations`,
    {
      method,
      headers: { 'content-type': 'application/json', 'x-collect-key': key },
      body: method === 'POST' ? JSON.stringify(station) : undefined
    }
  );
  if (resp.status === 403) {
    rememberKey('');
    throw new Error('密钥不对，再点一次重新输入');
  }
  if (!resp.ok) {
    let detail = `${resp.status} ${resp.statusText}`;
    try { detail = (await resp.json()).error || detail; } catch (_) {}
    throw new Error(detail);
  }
  rememberKey(key);
  const result = await resp.json();
  state.stations = result.stations || [];
  return result;
}

/** Redraw everything that depends on the tracked list. */
function afterStationsChange() {
  const series = (state.history && state.history.series) || {};
  const tracked = new Set(state.stations.map((s) => String(s.id)));
  for (const id of [...state.selected]) if (!tracked.has(id)) state.selected.delete(id);
  if (state.selected.size === 0) {
    state.stations.filter((s) => series[String(s.id)]).slice(0, 6)
      .forEach((s) => state.selected.add(String(s.id)));
  }
  if (state.history) { drawChart(); drawLegend(); }
  renderResults();
  loadLive();
}

async function follow(id, button) {
  const station = state.found.find((r) => String(r.id) === String(id));
  if (!station) return;
  button.disabled = true;
  try {
    const { distance_mi, ...record } = station;
    await editStations('POST', { station: record });
    toast(`已关注 ${labelOf(station)}，下一次采样开始记录`);
    afterStationsChange();
  } catch (err) {
    toast(err.message);
    button.disabled = false;
  }
}

async function unfollow(id, button) {
  const station = state.stations.find((s) => String(s.id) === String(id)) || { id };
  if (!window.confirm(`取消关注 ${labelOf(station)}？已记录的历史会保留，只是不再采样。`)) return;
  button.disabled = true;
  try {
    await editStations('DELETE', { id });
    toast(`已取消关注 ${labelOf(station)}`);
    afterStationsChange();
  } catch (err) {
    toast(err.message);
    button.disabled = false;
  }
}

$('live-cards').addEventListener('click', (event) => {
  const button = event.target.closest('button.unfollow');
  if (button) unfollow(button.dataset.id, button);
});

// --- search (live only, never recorded) -------------------------------------

function renderResults() {
  if (state.found.length === 0) return;
  const tracked = new Set(state.stations.map((s) => String(s.id)));
  $('results').innerHTML = `<table><thead><tr>
      <th class="num">编号</th><th>城市</th><th>地址</th>
      <th class="num">英里</th><th class="num">实时价</th><th class="num">关注</th></tr></thead><tbody>` +
    state.found.map((r) => {
      const on = tracked.has(String(r.id));
      return `<tr>
        <td class="num">${r.id}</td>
        <td>${r.city}</td>
        <td style="color:var(--muted)">${r.address}</td>
        <td class="num">${r.distance_mi == null ? '—' : r.distance_mi.toFixed(1)}</td>
        <td class="num"><button class="peek" data-id="${r.id}">查价</button></td>
        <td class="num"><button class="${on ? 'unfollow-row' : 'follow'}" data-id="${r.id}">${on ? '已关注 ✓' : '关注'}</button></td>
      </tr>`;
    }).join('') + '</tbody></table>';
}

async function runSearch() {
  const zip = $('zip').value.trim();
  $('search-status').textContent = '查询中…';
  try {
    const found = await getJSON(`${WORKER}/search?zip=${encodeURIComponent(zip)}&limit=8`);
    $('search-status').textContent = `${found.label} 附近`;
    state.found = found.results || [];
    if (state.found.length === 0) $('results').innerHTML = '<div class="empty">附近没有带加油站的 Costco</div>';
    renderResults();
  } catch (err) {
    state.found = [];
    $('search-status').textContent = '';
    $('results').innerHTML = `<div class="empty">${err.message}</div>`;
  }
}

$('results').addEventListener('click', async (event) => {
  const followButton = event.target.closest('button.follow');
  if (followButton) return follow(followButton.dataset.id, followButton);
  const unfollowButton = event.target.closest('button.unfollow-row');
  if (unfollowButton) return unfollow(unfollowButton.dataset.id, unfollowButton);

  const button = event.target.closest('button.peek');
  if (!button) return;
  const id = button.dataset.id;
  button.disabled = true;
  button.textContent = '…';
  try {
    const data = await getJSON(`${WORKER}/live?ids=${id}`);
    const entry = data.stations[id] || {};
    if (entry.error) throw new Error(entry.error);
    const text = Object.entries(entry.prices).sort()
      .map(([fuel, price]) => `${fuel} ${money(price)}`).join('  ');
    button.replaceWith(Object.assign(document.createElement('span'), {
      style: 'font-variant-numeric:tabular-nums', textContent: text || '无挂牌价'
    }));
  } catch (err) {
    toast(err.message);
    button.disabled = false;
    button.textContent = '查价';
  }
});

// --- history ----------------------------------------------------------------

async function loadHistory() {
  try {
    state.history = await getJSON('data/history.json');
  } catch (err) {
    $('chart').innerHTML = `<div class="empty">历史数据读取失败：${err.message}</div>`;
    return;
  }
  const series = state.history.series || {};
  const fuels = [...new Set(Object.values(series).flatMap((f) => Object.keys(f)))].sort();
  if (!state.fuel || !fuels.includes(state.fuel)) {
    state.fuel = fuels.includes('regular') ? 'regular' : fuels[0];
  }
  $('fuel').innerHTML = fuels
    .map((f) => `<option value="${f}"${f === state.fuel ? ' selected' : ''}>${f}</option>`)
    .join('') || '<option>—</option>';

  const withData = state.stations.filter((s) => series[String(s.id)]);
  if (state.selected.size === 0) withData.slice(0, 6).forEach((s) => state.selected.add(String(s.id)));

  $('history-note').textContent =
    `每天 ${window.GAS_CONFIG.SLOTS} 各采样一次，写入仓库的 data/history.json。` +
    `最后一次采样：${relative(state.history.updated)}。`;

  drawChart();
  drawLegend();
}

function drawLegend() {
  const series = state.history.series || {};
  $('legend').innerHTML = state.stations.filter((s) => series[String(s.id)]).map((s) => {
    const on = state.selected.has(String(s.id));
    return `<button class="chip ${on ? 'on' : ''}" data-id="${s.id}"
      style="color:${on ? colorOf(s.id) : 'var(--muted)'}"><span class="dot"></span>${labelOf(s)}</button>`;
  }).join('');
}

$('legend').addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  const id = chip.dataset.id;
  if (state.selected.has(id)) {
    if (state.selected.size === 1) return toast('至少保留一个站点');
    state.selected.delete(id);
  } else {
    state.selected.add(id);
  }
  drawChart();
  drawLegend();
});

function drawChart() {
  const W = 880, H = 300, pad = { top: 16, right: 16, bottom: 28, left: 52 };
  const series = state.history.series || {};
  const picked = [...state.selected]
    .map((id) => ({ id, points: (series[id] || {})[state.fuel] || [] }))
    .filter((s) => s.points.length);

  const all = picked.flatMap((s) => s.points.map((p) => p[1]));
  if (all.length === 0) {
    $('chart').innerHTML = '<div class="empty">这个窗口里还没有数据。采集每天跑两次，攒几天就有了。</div>';
    $('chart-hint').textContent = '';
    return;
  }

  const now = Date.now();
  const earliest = Math.min(...picked.flatMap((s) => s.points.map((p) => parseStamp(p[0]).getTime())));
  const t0 = Math.min(earliest, now - state.days * 86400000);
  const t1 = now;

  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 0.05) { const mid = (hi + lo) / 2; lo = mid - 0.05; hi = mid + 0.05; }
  const padY = (hi - lo) * 0.12;
  lo -= padY; hi += padY;

  const x = (t) => pad.left + ((t - t0) / Math.max(t1 - t0, 1)) * (W - pad.left - pad.right);
  const y = (v) => pad.top + ((hi - v) / (hi - lo)) * (H - pad.top - pad.bottom);

  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="油价历史走势">`;
  for (let i = 0; i <= 4; i++) {
    const value = lo + ((hi - lo) * i) / 4;
    svg += `<line class="grid-line" x1="${pad.left}" x2="${W - pad.right}"
        y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}"/>
      <text class="axis-text" x="${pad.left - 8}" y="${(y(value) + 4).toFixed(1)}"
        text-anchor="end">${value.toFixed(2)}</text>`;
  }
  for (let i = 0; i <= 4; i++) {
    const t = t0 + ((t1 - t0) * i) / 4;
    const label = new Date(t).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
    svg += `<text class="axis-text" x="${x(t).toFixed(1)}" y="${H - 8}"
        text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}">${label}</text>`;
  }

  // A posted price holds until the next change, so the line steps rather than slopes.
  for (const s of picked) {
    let d = '';
    s.points.forEach((point, index) => {
      const px = x(parseStamp(point[0]).getTime()), py = y(point[1]);
      d += index === 0 ? `M${px.toFixed(1)},${py.toFixed(1)}` : `H${px.toFixed(1)}V${py.toFixed(1)}`;
    });
    d += `H${x(t1).toFixed(1)}`;
    svg += `<path d="${d}" fill="none" stroke="${colorOf(s.id)}" stroke-width="2"
      stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      <circle cx="${x(t1).toFixed(1)}" cy="${y(s.points[s.points.length - 1][1]).toFixed(1)}"
        r="3" fill="${colorOf(s.id)}"/>`;
  }
  $('chart').innerHTML = svg + '</svg>';

  const samples = picked.reduce((n, s) => n + s.points.length, 0);
  const span = (now - earliest) / 86400000;
  $('chart-hint').textContent = span < 2
    ? `${state.fuel} · 目前只有 ${span < 1 / 24 ? '不到 1 小时' : `${Math.round(span * 24)} 小时`}的历史，攒几天曲线才有形状`
    : `${state.fuel} · ${samples} 个采样点`;
}

$('fuel').addEventListener('change', (e) => { state.fuel = e.target.value; drawChart(); });
$('days').addEventListener('change', (e) => { state.days = Number(e.target.value); drawChart(); });
$('search').addEventListener('click', runSearch);
$('zip').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
$('refresh').addEventListener('click', async () => {
  const button = $('refresh');
  button.disabled = true;
  button.textContent = '读取中…';
  await loadLive();
  button.disabled = false;
  button.textContent = '刷新实时价';
});

(async function start() {
  // The Worker reads the list straight from the repo, so a follow made a
  // minute ago shows up before Pages has redeployed. The same-origin file is
  // the fallback when the Worker is down.
  try {
    state.stations = (await getJSON(`${WORKER}/stations`)).stations || [];
  } catch (_) {
    try {
      state.stations = (await getJSON('data/stations.json')).stations || [];
    } catch (err) {
      $('live-cards').innerHTML = `<div class="empty">站点清单读取失败：${err.message}</div>`;
      return;
    }
  }
  await loadHistory();
  await loadLive();
})();
