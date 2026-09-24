/* Gas Tracker — Cloudflare Worker.

   WHY THIS EXISTS: the site is a static GitHub Pages page with no backend, and
   it needs two things a static page cannot do for itself.

   1. Live prices. Costco's price endpoint sends
        access-control-allow-origin: https://my.costco.ca
      so the browser refuses the response for any other origin. This Worker
      fetches it server-side and re-serves it with our own CORS header.

   2. Twice-daily history. A Cron Trigger wakes the Worker at 11:00 and 17:00
      America/Los_Angeles, reads the prices, and appends them to
      data/history.json in the GitHub repo through the Contents API. The repo
      is the database; the page reads that file straight from its own origin.

   The live endpoint deliberately writes nothing — looking up a station must
   never disturb the history series.

   ── Self-hosting (Cloudflare dashboard, no CLI needed) ──────────────────
   1. Workers & Pages → Create Worker → paste this whole file → Deploy
   2. Worker → Settings → Variables and Secrets:
        Secret  GH_TOKEN = a fine-grained PAT scoped to THIS repo only,
                           Repository permissions → Contents: Read and write
      Plain-text variables, only if you are not the defaults below:
        GH_REPO         e.g. 'nonnoob/gas-tracker'
        GH_BRANCH       default 'main'
        ALLOWED_ORIGIN  comma-separated; default is the Pages origin
   3. Worker → Settings → Triggers → Cron Triggers, add both:
        0 18 * * *      and      0 0 * * *
      Two more make it daylight-saving-proof (the handler ignores the wrong one):
        0 19 * * *      and      0 1 * * *
*/

const DEFAULTS = {
  GH_REPO: 'nonnoob/gas-tracker',
  GH_BRANCH: 'main',
  ALLOWED_ORIGIN: 'https://nonnoob.github.io,http://localhost:8000,http://127.0.0.1:8000',
  HISTORY_PATH: 'data/history.json',
  STATIONS_PATH: 'data/stations.json'
};

// The slots we record, in America/Los_Angeles. Cron fires in UTC, which drifts
// an hour across daylight saving, so the schedule covers both possibilities and
// this list decides whether a given firing is a real slot.
const SLOT_HOURS = [11, 17];

const COSTCO_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const conf = (env, key) => env[key] || DEFAULTS[key];

/** A caller's mistake (400), as opposed to an upstream failure (502). */
class BadRequest extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- small helpers ----------------------------------------------------------

function corsHeaders(req, env) {
  const allowed = conf(env, 'ALLOWED_ORIGIN').split(',').map((s) => s.trim());
  const origin = req.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,x-collect-key',
    Vary: 'Origin'
  };
}

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) }
  });

function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64decode(b64) {
  const binary = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** UTC minute-precision stamp, e.g. 2026-09-21T18:00Z — the history's time format. */
const stamp = (date) => date.toISOString().slice(0, 16) + 'Z';

/** The hour of `date` in America/Los_Angeles, daylight saving included. */
function losAngelesHour(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    hour12: false
  }).formatToParts(date);
  return Number(parts.find((p) => p.type === 'hour').value) % 24;
}

// --- Costco -----------------------------------------------------------------

async function costcoPrices(id, attempt = 0) {
  const resp = await fetch(
    `https://www.costco.com/AjaxGetGasPricesService?warehouseid=${encodeURIComponent(id)}`,
    { headers: { 'User-Agent': COSTCO_UA, Accept: 'application/json' } }
  );
  // Costco rate-limits bursts. Requests here are already serialised; this backs
  // off once more in case another client of ours is fetching at the same moment.
  if (resp.status === 429 && attempt < 2) {
    await sleep(600 * (attempt + 1));
    return costcoPrices(id, attempt + 1);
  }
  if (!resp.ok) throw new Error(`costco ${resp.status} for #${id}`);
  const payload = await resp.json();
  if (payload && payload.errorMessage) throw new Error(`#${id}: ${payload.errorMessage}`);

  // Grades vary by warehouse (diesel and 0% ethanol exist only at some), so
  // take whatever keys come back rather than a fixed list.
  const out = {};
  for (const grades of Object.values(payload || {})) {
    if (!grades || typeof grades !== 'object') continue;
    for (const [fuel, raw] of Object.entries(grades)) {
      const value = Number(raw);
      if (Number.isFinite(value) && value > 0) out[fuel.toLowerCase()] = value;
    }
  }
  return out;
}

async function costcoSearch(lat, lon, limit) {
  const params = new URLSearchParams({
    langId: '-1',
    storeId: '10301',
    numOfWarehouses: String(limit),
    hasGas: 'true',
    populateClientWarehouseObj: 'true',
    countryCode: 'US',
    latitude: lat.toFixed(6),
    longitude: lon.toFixed(6)
  });
  const resp = await fetch(`https://www.costco.com/AjaxWarehouseBrowseLookupView?${params}`, {
    headers: { 'User-Agent': COSTCO_UA, Accept: 'application/json' }
  });
  if (!resp.ok) throw new Error(`costco search ${resp.status}`);
  const payload = await resp.json();

  // Response is [true, {warehouse}, ...] — the leading flag is not a warehouse.
  const out = [];
  for (const entry of Array.isArray(payload) ? payload : []) {
    if (!entry || typeof entry !== 'object' || !entry.hasGasDepartment) continue;
    const id = Number(entry.identifier);
    if (!Number.isFinite(id)) continue;
    const title = (s) => (s || '').trim().replace(/\w\S*/g, (w) =>
      w[0].toUpperCase() + w.slice(1).toLowerCase());
    out.push({
      id,
      city: title(entry.city),
      state: (entry.state || '').trim().toUpperCase(),
      address: title(entry.address1),
      lat: Number(entry.latitude),
      lon: Number(entry.longitude),
      distance_mi: typeof entry.distance === 'number' ? entry.distance : null
    });
  }
  out.sort((a, b) => (a.distance_mi ?? 9e9) - (b.distance_mi ?? 9e9));
  return out;
}

/** Costco's search ignores a zip code, so resolve it to coordinates first. */
async function geocodeZip(zip) {
  const resp = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`);
  if (resp.status === 404) throw new BadRequest(`unknown US zip code: ${zip}`);
  if (!resp.ok) throw new Error(`zip lookup failed (${resp.status})`);
  const place = ((await resp.json()).places || [])[0];
  if (!place) throw new BadRequest(`no place for zip ${zip}`);
  return {
    lat: Number(place.latitude),
    lon: Number(place.longitude),
    label: `${place['place name']}, ${place['state abbreviation']}`
  };
}

// --- GitHub as the database -------------------------------------------------

async function ghRead(env, path) {
  const repo = conf(env, 'GH_REPO');
  const branch = conf(env, 'GH_BRANCH');
  const resp = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`,
    {
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        accept: 'application/vnd.github+json',
        'User-Agent': 'gas-tracker-worker'
      }
    }
  );
  if (resp.status === 404) return { data: null, sha: null };
  if (!resp.ok) throw new Error(`github read ${path}: ${resp.status} ${await resp.text()}`);
  const body = await resp.json();
  return { data: JSON.parse(b64decode(body.content)), sha: body.sha };
}

async function ghWrite(env, path, data, sha, message) {
  const repo = conf(env, 'GH_REPO');
  const resp = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'User-Agent': 'gas-tracker-worker'
    },
    body: JSON.stringify({
      message,
      content: b64encode(JSON.stringify(data, null, 2) + '\n'),
      branch: conf(env, 'GH_BRANCH'),
      ...(sha ? { sha } : {})
    })
  });
  if (!resp.ok) throw new Error(`github write ${path}: ${resp.status} ${await resp.text()}`);
}

/** Read prices for every tracked station and append one sample per fuel. */
async function collect(env, at) {
  const { data: stationFile } = await ghRead(env, conf(env, 'STATIONS_PATH'));
  const stations = (stationFile && stationFile.stations) || [];
  if (stations.length === 0) return { recorded: 0, errors: ['stations.json is empty'] };

  const { data: historyFile, sha } = await ghRead(env, conf(env, 'HISTORY_PATH'));
  const history = historyFile && historyFile.series ? historyFile : { updated: null, series: {} };

  const when = stamp(at);
  const errors = [];
  let recorded = 0;

  for (const station of stations) {
    let prices;
    try {
      if (recorded || errors.length) await sleep(300);
      prices = await costcoPrices(station.id);
    } catch (err) {
      errors.push(String(err.message || err));
      continue;
    }
    const bucket = (history.series[String(station.id)] ||= {});
    for (const [fuel, price] of Object.entries(prices)) {
      const series = (bucket[fuel] ||= []);
      // A cron can fire twice for one slot (retries); never write the same
      // stamp twice or the chart grows duplicate points.
      if (series.length && series[series.length - 1][0] === when) {
        series[series.length - 1][1] = price;
      } else {
        series.push([when, price]);
      }
      recorded += 1;
    }
  }

  if (recorded === 0) return { recorded, errors };
  history.updated = when;
  await ghWrite(env, conf(env, 'HISTORY_PATH'), history, sha,
    `data: prices at ${when}${errors.length ? ` (${errors.length} failed)` : ''}`);
  return { recorded, errors };
}

/** Clean one station record from the page; only these fields are stored. */
function stationRecord(body) {
  const id = Number(body && body.id);
  if (!Number.isInteger(id) || id <= 0) throw new BadRequest('station id required');
  const text = (v) => String(v ?? '').trim().slice(0, 80);
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))
    ? null : Number(v));
  return {
    id,
    city: text(body.city),
    state: text(body.state).toUpperCase(),
    address: text(body.address),
    lat: num(body.lat),
    lon: num(body.lon)
  };
}

/** Add (station) or remove (removeId) one entry in stations.json. */
async function editStations(env, { station, removeId }) {
  const path = conf(env, 'STATIONS_PATH');
  // The sha guards against a concurrent edit; GitHub answers 409 and we retry
  // once against the fresh file.
  for (let attempt = 0; ; attempt++) {
    const { data, sha } = await ghRead(env, path);
    const stations = (data && data.stations) || [];
    const has = (id) => stations.some((s) => String(s.id) === String(id));
    let message;
    if (station) {
      if (has(station.id)) return { stations, changed: false };
      stations.push(station);
      message = `track: #${station.id}${station.city ? ` ${station.city}` : ''}`;
    } else {
      if (!has(removeId)) return { stations, changed: false };
      const gone = stations.find((s) => String(s.id) === String(removeId));
      stations.splice(stations.indexOf(gone), 1);
      message = `untrack: #${gone.id}${gone.city ? ` ${gone.city}` : ''}`;
    }
    try {
      await ghWrite(env, path, { ...(data || {}), stations }, sha, message);
      return { stations, changed: true };
    } catch (err) {
      if (attempt === 0 && /: 409 /.test(String(err.message))) continue;
      throw err;
    }
  }
}

// --- handlers ---------------------------------------------------------------

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(req.url);
    try {
      // Live prices. Reads only — nothing here touches the history.
      if (url.pathname === '/live') {
        const ids = (url.searchParams.get('ids') || '')
          .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12);
        if (ids.length === 0) throw new BadRequest('ids required');
        // Serial, not Promise.all: Costco answers a burst of concurrent
        // requests with 429 and we get nothing back at all.
        const entries = [];
        for (const id of ids) {
          if (entries.length) await sleep(250);
          try {
            entries.push([id, { prices: await costcoPrices(id) }]);
          } catch (err) {
            entries.push([id, { error: String(err.message || err) }]);
          }
        }
        return json(
          { at: stamp(new Date()), stations: Object.fromEntries(entries) },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=60' } }
        );
      }

      if (url.pathname === '/search') {
        const zip = url.searchParams.get('zip');
        const limit = Math.min(Number(url.searchParams.get('limit')) || 10, 25);
        const rawLat = url.searchParams.get('lat');
        const rawLon = url.searchParams.get('lon');
        // Number(null) is 0, so a missing parameter must be rejected by
        // presence rather than by Number.isFinite alone.
        let lat = rawLat === null ? NaN : Number(rawLat);
        let lon = rawLon === null ? NaN : Number(rawLon);
        let label = null;
        if (zip) {
          const place = await geocodeZip(zip);
          ({ lat, lon } = place);
          label = place.label;
        }
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          throw new BadRequest('zip, or lat and lon, required');
        }
        return json(
          { label, results: await costcoSearch(lat, lon, limit) },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=86400' } }
        );
      }

      // The tracked list. GET is public and reads the repo directly, so the page
      // sees an edit at once instead of waiting for Pages to redeploy.
      // POST adds, DELETE removes; both need the same key as /collect.
      if (url.pathname === '/stations') {
        if (req.method === 'GET') {
          const { data } = await ghRead(env, conf(env, 'STATIONS_PATH'));
          return json({ stations: (data && data.stations) || [] },
            { headers: { ...cors, 'Cache-Control': 'no-store' } });
        }
        if (req.method === 'POST' || req.method === 'DELETE') {
          if (!env.COLLECT_KEY || req.headers.get('x-collect-key') !== env.COLLECT_KEY) {
            return json({ error: 'forbidden' }, { status: 403, headers: cors });
          }
          let edit;
          if (req.method === 'POST') {
            let body;
            try { body = await req.json(); } catch (_) { throw new BadRequest('JSON body required'); }
            edit = { station: stationRecord(body) };
          } else {
            const id = Number(url.searchParams.get('id'));
            if (!Number.isInteger(id) || id <= 0) throw new BadRequest('id required');
            edit = { removeId: id };
          }
          return json(await editStations(env, edit), { headers: cors });
        }
      }

      // Manual trigger, for verifying the write path without waiting for cron.
      if (url.pathname === '/collect' && req.method === 'POST') {
        if (!env.COLLECT_KEY || req.headers.get('x-collect-key') !== env.COLLECT_KEY) {
          return json({ error: 'forbidden' }, { status: 403, headers: cors });
        }
        return json(await collect(env, new Date()), { headers: cors });
      }

      return json({ error: 'not found', routes: ['/live', '/search', '/stations', '/collect'] },
        { status: 404, headers: cors });
    } catch (err) {
      const status = err instanceof BadRequest ? 400 : 502;
      return json({ error: String(err.message || err) }, { status, headers: cors });
    }
  },

  async scheduled(event, env, ctx) {
    const at = new Date(event.scheduledTime);
    // Four cron entries cover both standard and daylight time; only the firing
    // that lands on a real slot does anything.
    if (!SLOT_HOURS.includes(losAngelesHour(at))) return;
    ctx.waitUntil(
      collect(env, at)
        .then((result) => {
          if (result.errors.length) console.error('collect errors', result.errors);
          else console.log(`collected ${result.recorded} price(s) at ${stamp(at)}`);
        })
        // Without this the whole run fails silently — a missing GH_TOKEN throws
        // inside ghRead and the tail log shows nothing to explain it.
        .catch((err) => console.error('collect failed:', String(err && err.message || err)))
    );
  }
};
