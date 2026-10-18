#!/usr/bin/env node
// List Google Ads conversion actions with the fields a tracking audit needs. Read only (GAQL search).
// Usage: node ads-conversion-actions.mjs <customer-id> [--json] [--include-removed] [--api-version v23]
// Env names (values never printed):
//   GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET,
//   GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID (manager id, optional)
// No dependencies. Node 18 or newer.

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const customerId = (argv.find((a) => /^[\d-]{10,12}$/.test(a)) || '').replace(/-/g, '');
const version = opt('--api-version', 'v23');

if (!customerId) {
  console.error('usage: node ads-conversion-actions.mjs <customer-id> [--json] [--include-removed] [--api-version v23]');
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
  conversion_action.id,
  conversion_action.name,
  conversion_action.type,
  conversion_action.status,
  conversion_action.category,
  conversion_action.origin,
  conversion_action.primary_for_goal,
  conversion_action.counting_type,
  conversion_action.include_in_conversions_metric,
  conversion_action.click_through_lookback_window_days,
  conversion_action.view_through_lookback_window_days,
  conversion_action.attribution_model_settings.attribution_model,
  conversion_action.value_settings.default_value,
  conversion_action.value_settings.always_use_default_value,
  conversion_action.google_analytics_4_settings.event_name,
  conversion_action.google_analytics_4_settings.property_name,
  conversion_action.google_analytics_4_settings.property_id
FROM conversion_action
${flag('--include-removed') ? '' : "WHERE conversion_action.status != 'REMOVED'"}`;

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
  const r = await fetch(`https://googleads.googleapis.com/${version}/customers/${customerId}/googleAds:search`, {
    method: 'POST', headers, body: JSON.stringify({ query: QUERY }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error?.message || JSON.stringify(j).slice(0, 400);
    throw new Error(`GAQL HTTP ${r.status}: ${msg}`);
  }
  const rows = (j.results || []).map((x) => x.conversionAction);
  if (flag('--json')) return console.log(JSON.stringify(rows, null, 2));

  console.log(`conversion actions: ${rows.length}`);
  console.log('id | name | type | status | category | origin | primary | counting | in_conversions | click_days | view_days | attribution | ga4_event | ga4_property');
  for (const c of rows) {
    const g = c.googleAnalytics4Settings || {};
    console.log([
      c.id, c.name, c.type, c.status, c.category, c.origin || '-',
      c.primaryForGoal, c.countingType, c.includeInConversionsMetric,
      c.clickThroughLookbackWindowDays, c.viewThroughLookbackWindowDays,
      c.attributionModelSettings?.attributionModel || '-',
      g.eventName || '-', g.propertyName || g.propertyId || '-',
    ].join(' | '));
  }
  const events = new Map();
  for (const c of rows) {
    const e = c.googleAnalytics4Settings?.eventName;
    if (e && c.status !== 'REMOVED') events.set(e, (events.get(e) || 0) + 1);
  }
  for (const [e, n] of events) if (n > 1) console.log(`WARN duplicate: GA4 event ${e} imported ${n} times`);
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });
