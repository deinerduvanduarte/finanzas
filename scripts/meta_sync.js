/**
 * meta_sync.js — Sincroniza gasto y leads de Meta Ads → meta_data.json
 * Corre en GitHub Actions cada 15 min. Token desde META_TOKEN (GitHub Secret).
 */

const fs = require('fs');

// ── CONFIG ─────────────────────────────────────────────────────
const ACCOUNTS = [
  'act_2235837880587647', // NEXORA 1
  'act_763369709939342',  // NEXORA 2
  // agrega más cuentas aquí: 'act_XXXXXXXX',
];
const API = 'https://graph.facebook.com/v21.0';
const TOKEN = process.env.META_TOKEN;
const DAYS_BACK = 30;
const OUT_FILE = 'meta_data.json';

if (!TOKEN) {
  console.error('ERROR: falta la variable META_TOKEN');
  process.exit(1);
}

// ── HELPERS ────────────────────────────────────────────────────
const ymd = (d) => d.toISOString().slice(0, 10);

function extractLeads(actions) {
  if (!Array.isArray(actions)) return 0;
  const LEAD_TYPES = [
    'onsite_conversion.messaging_conversation_started_7d',
    'lead',
    'onsite_conversion.lead_grouped',
  ];
  let total = 0;
  const seen = new Set();
  for (const a of actions) {
    if (LEAD_TYPES.includes(a.action_type) && !seen.has(a.action_type)) {
      total += parseInt(a.value, 10) || 0;
      seen.add(a.action_type);
    }
  }
  return total;
}

async function fetchAllPages(url) {
  const rows = [];
  let next = url;
  let guard = 0;
  while (next && guard < 20) {
    const res = await fetch(next);
    const json = await res.json();
    if (json.error) {
      throw new Error(`Meta API [${json.error.code}]: ${json.error.message}`);
    }
    if (Array.isArray(json.data)) rows.push(...json.data);
    next = json.paging && json.paging.next ? json.paging.next : null;
    guard++;
  }
  return rows;
}

async function accountInsights(account, since, until) {
  const params = new URLSearchParams({
    fields: 'campaign_id,campaign_name,spend,actions',
    level: 'campaign',
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
    limit: '500',
    access_token: TOKEN,
  });
  const rows = await fetchAllPages(`${API}/${account}/insights?${params}`);
  return rows.map((r) => ({
    date: r.date_start,
    account,
    campaign_id: r.campaign_id,
    campaign_name: r.campaign_name || '',
    spend: parseFloat(r.spend) || 0,
    leads: extractLeads(r.actions),
  }));
}

async function accountInfo(account) {
  try {
    const params = new URLSearchParams({ fields: 'name,currency,account_status', access_token: TOKEN });
    const res = await fetch(`${API}/${account}?${params}`);
    const j = await res.json();
    if (j.error) return { id: account, name: account, currency: '?', status: 0 };
    return { id: account, name: j.name || account, currency: j.currency || '?', status: j.account_status || 0 };
  } catch {
    return { id: account, name: account, currency: '?', status: 0 };
  }
}

// ── MAIN ───────────────────────────────────────────────────────
(async () => {
  const nowCO = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const today = ymd(new Date(nowCO.getTime() - nowCO.getTimezoneOffset() * 60000));
  const sinceD = new Date(nowCO);
  sinceD.setDate(sinceD.getDate() - DAYS_BACK);
  const since = ymd(new Date(sinceD.getTime() - sinceD.getTimezoneOffset() * 60000));

  console.log(`Sync Meta Ads · ${since} → ${today} · ${ACCOUNTS.length} cuentas`);

  const allRows = [];
  const accounts = [];
  for (const acc of ACCOUNTS) {
    try {
      const [info, rows] = await Promise.all([
        accountInfo(acc),
        accountInsights(acc, since, today),
      ]);
      accounts.push(info);
      allRows.push(...rows);
      console.log(`  ${info.name} (${acc}): ${rows.length} filas`);
    } catch (e) {
      console.error(`  ERROR en ${acc}: ${e.message}`);
      accounts.push({ id: acc, name: acc, currency: '?', status: -1, error: e.message });
    }
  }

  const todayRows = allRows.filter((r) => r.date === today);
  const todaySpend = todayRows.reduce((s, r) => s + r.spend, 0);
  const todayLeads = todayRows.reduce((s, r) => s + r.leads, 0);

  const byDate = {};
  for (const r of allRows) {
    if (!byDate[r.date]) byDate[r.date] = { date: r.date, spend: 0, leads: 0 };
    byDate[r.date].spend += r.spend;
    byDate[r.date].leads += r.leads;
  }
  const daily = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

  const out = {
    updated_at: new Date().toISOString(),
    updated_at_co: new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
    since,
    until: today,
    accounts,
    today: {
      date: today,
      spend: Math.round(todaySpend * 100) / 100,
      leads: todayLeads,
      campaigns: todayRows
        .sort((a, b) => b.spend - a.spend)
        .map((r) => ({
          account: r.account,
          campaign_id: r.campaign_id,
          campaign_name: r.campaign_name,
          spend: Math.round(r.spend * 100) / 100,
          leads: r.leads,
        })),
    },
    daily,
    rows: allRows.map((r) => ({
      d: r.date,
      a: r.account,
      c: r.campaign_name,
      s: Math.round(r.spend * 100) / 100,
      l: r.leads,
    })),
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 1));
  console.log(`OK → ${OUT_FILE} · hoy: $${todaySpend.toFixed(0)} · ${todayLeads} leads · ${allRows.length} filas`);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
