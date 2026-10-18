#!/usr/bin/env node
// Pull Google Ads search terms (search_term_view) per day, CSV to stdout. Read only (GAQL search).
// Usage: node search-terms.mjs <customer-id> --from YYYY-MM-DD --to YYYY-MM-DD [--api-version v23] [--include-zero-cost]
//    or: node search-terms.mjs <customer-id> --days 90     (ends yesterday)
// Env names (values never printed):
//   GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET,
//   GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID (manager id, optional)
// Output columns: date,search_term,status,campaign,ad_group,cost,clicks,impressions,conversions,conversions_value
// Daily rows on purpose: the join step needs spend by day for the CRM lag model.
// No dependencies. Node 18 or newer.

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const customerId = (argv.find((a) => /^[\d-]{10,12}$/.test(a)) || '').replace(/-/g, '');
const version = opt('--api-version', 'v23');
const iso = (d) => d.toISOString().slice(0, 10);

let from = opt('--from');
let to = opt('--to');
const days = Number(opt('--days', 0));
if (days > 0) {
  const end = new Date(Date.now() - 86400000);
  to = iso(end);
  from = iso(new Date(end.getTime() - (days - 1) * 86400000));
}
if (!customerId || !/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
  console.error('usage: node search-terms.mjs <customer-id> --from YYYY-MM-DD --to YYYY-MM-DD [--include-zero-cost]\n   or: node search-terms.mjs <customer-id> --days 90');
  process.exit(2);
}
const need = (n) => {
  const v = process.env[n];
  if (!v) { console.error(`missing env var ${n}`); process.exit(2); }
  return v;
};

async function accessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: need('GOOGLE_ADS_CLIENT_ID'),
      client_secret: need('GOOGLE_ADS_CLIENT_SECRET'),
      refresh_token: need('GOOGLE_ADS_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`token exchange failed: HTTP ${r.status} ${j.error || ''}`.trim());
  return j.access_token;
}

const QUERY = `SELECT
  segments.date,
  search_term_view.search_term,
  search_term_view.status,
  campaign.name,
  ad_group.name,
  metrics.cost_micros,
  metrics.clicks,
  metrics.impressions,
  metrics.conversions,
  metrics.conversions_value
FROM search_term_view
WHERE segments.date BETWEEN '${from}' AND '${to}'
${flag('--include-zero-cost') ? '' : 'AND metrics.cost_micros > 0'}
ORDER BY segments.date`;

const esc = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const t = await accessToken();
  const headers = {
    Authorization: `Bearer ${t}`,
    'developer-token': need('GOOGLE_ADS_DEVELOPER_TOKEN'),
    'Content-Type': 'application/json',
  };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    headers['login-customer-id'] = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, '');
  }
  const url = `https://googleads.googleapis.com/${version}/customers/${customerId}/googleAds:search`;
  const rows = [];
  let pageToken;
  do {
    const r = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ query: QUERY, ...(pageToken ? { pageToken } : {}) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j.error?.message || '') + ' ' + JSON.stringify(j.error?.details || j).slice(0, 600);
      throw new Error(`GAQL HTTP ${r.status}: ${msg}`);
    }
    rows.push(...(j.results || []));
    pageToken = j.nextPageToken;
  } while (pageToken);

  console.log('date,search_term,status,campaign,ad_group,cost,clicks,impressions,conversions,conversions_value');
  let cost = 0;
  for (const x of rows) {
    const m = x.metrics || {};
    const c = Number(m.costMicros || 0) / 1e6;
    cost += c;
    console.log([
      x.segments?.date, x.searchTermView?.searchTerm, x.searchTermView?.status || '',
      x.campaign?.name, x.adGroup?.name,
      c.toFixed(2), m.clicks || 0, m.impressions || 0,
      Number(m.conversions || 0).toFixed(2), Number(m.conversionsValue || 0).toFixed(2),
    ].map(esc).join(','));
  }
  console.error(`rows: ${rows.length}, cost: ${cost.toFixed(2)}, range: ${from} to ${to}`);
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });
