// FR+ lead handler (Vercel serverless function).
// Receives the landing-page form POST, forwards it to a Google Sheet via Apps Script
// (the system of record: this write is required and blocking, nothing below here runs
// if it fails), then fans out, concurrently and non-blockingly, to whichever of the
// following are configured: Meta Conversions API, a Telegram sales channel, and a
// future CRM webhook. Each fan-out leg is independently optional, swallows its own
// errors, and runs in parallel with the others, so a missing or failing leg can never
// block the lead, slow the response beyond the single slowest configured leg, or take
// any other leg down with it.
//
// Set these in Vercel > Project > Settings > Environment Variables:
//   SHEET_WEBHOOK_URL   (required)  Google Apps Script web-app URL that appends the lead to the sheet
//                                   (GHL_WEBHOOK_URL is also accepted as a fallback name)
//   META_PIXEL_ID       (optional)  Enables server-side Meta CAPI (recommended once the pixel is live)
//   META_CAPI_TOKEN     (optional)  Conversions API access token, pairs with META_PIXEL_ID
//   TELEGRAM_BOT_TOKEN  (optional)  Bot token from @BotFather; pairs with TELEGRAM_CHAT_ID
//   TELEGRAM_CHAT_ID    (optional)  Chat/channel/group id the sales bot should post leads into
//   CRM_WEBHOOK_URL     (optional)  Generic POST target for whatever CRM replaces the sheet later.
//                                   Receives the exact same payload shape as the sheet, so pointing
//                                   FR+ at a real CRM once one exists is one env var, no code change.
//
// No dependencies, no package.json needed. fetch is global on Vercel's Node 18+ runtime.

const crypto = require('node:crypto');

const sha256 = (v) =>
  crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');

function normalisePhone(raw){
  const digits = String(raw || '').replace(/\D/g, '');
  if(!digits) return '';
  if(digits.startsWith('27')) return '+' + digits;
  if(digits.startsWith('0'))  return '+27' + digits.slice(1);
  return '+' + digits;
}

function escapeHtml(v){
  return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatTelegramMessage(payload){
  const lines = [
    '\u{1F7E3} <b>New FR Plus lead</b>',
    '',
    `<b>Name:</b> ${escapeHtml(payload.name)}`,
    `<b>Phone:</b> ${escapeHtml(payload.phone)}`,
    `<b>Email:</b> ${escapeHtml(payload.email)}`,
    `<b>Capital band:</b> ${escapeHtml(payload.capital_band)}`,
    payload.province ? `<b>Province:</b> ${escapeHtml(payload.province)}` : null
  ];
  if(payload.calc_portfolio_value || payload.calc_fee_pct || payload.calc_projected_leak){
    lines.push('', '<b>Calculator inputs:</b>');
    if(payload.calc_portfolio_value) lines.push(`Portfolio value: ${escapeHtml(payload.calc_portfolio_value)}`);
    if(payload.calc_fee_pct)         lines.push(`Fee %: ${escapeHtml(payload.calc_fee_pct)}`);
    if(payload.calc_projected_leak)  lines.push(`Projected leak: ${escapeHtml(payload.calc_projected_leak)}`);
  }
  const sourceLine = payload.utm_campaign
    ? `${escapeHtml(payload.source)} · ${escapeHtml(payload.utm_campaign)}`
    : escapeHtml(payload.source);
  lines.push('', `<b>Source:</b> ${sourceLine}`);
  lines.push(`<b>Submitted:</b> ${escapeHtml(payload.submitted_at)}`);
  return lines.filter((l) => l !== null).join('\n');
}

// Optional: server-side Meta Conversions API, fires alongside the browser pixel.
async function notifyMetaCapi(payload){
  const pixelId   = process.env.META_PIXEL_ID;
  const capiToken = process.env.META_CAPI_TOKEN;
  if(!pixelId || !capiToken) return;
  try{
    const fbc = payload.fbclid ? ('fb.1.' + Date.now() + '.' + payload.fbclid) : undefined;
    const res = await fetch('https://graph.facebook.com/v19.0/' + pixelId + '/events?access_token=' + capiToken, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({
        data:[{
          event_name:'Lead',
          event_time: Math.floor(Date.now()/1000),
          action_source:'website',
          event_source_url: payload.page_url || undefined,
          user_data:{
            em:[ sha256(payload.email) ],
            ph:[ sha256(payload.phone) ],
            ...(fbc ? { fbc } : {})
          }
        }]
      })
    });
    if(!res.ok) console.error('Meta CAPI returned', res.status);
  }catch(err){
    console.error('Meta CAPI error (non-blocking)', err);
  }
}

// Optional: ping a Telegram chat/channel so closers see every lead land in real time.
async function notifyTelegram(payload){
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if(!token || !chatId) return;
  try{
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: formatTelegramMessage(payload),
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    if(!res.ok) console.error('Telegram notify failed', res.status, await res.text().catch(() => ''));
  }catch(err){
    console.error('Telegram notify error (non-blocking)', err);
  }
}

// Optional, future: point this at a real CRM once one exists (Supabase, etc.).
// Same payload shape as the sheet, so this is the only line that changes later.
async function notifyCrm(payload){
  const url = process.env.CRM_WEBHOOK_URL;
  if(!url) return;
  try{
    const res = await fetch(url, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });
    if(!res.ok) console.error('CRM webhook returned', res.status);
  }catch(err){
    console.error('CRM webhook error (non-blocking)', err);
  }
}

module.exports = async (req, res) => {
  if(req.method !== 'POST'){
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  let body = req.body;
  if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch(e){ body = {}; } }
  body = body || {};

  // Honeypot: silently accept and drop
  if(body.company_website && String(body.company_website).trim() !== ''){
    return res.status(200).json({ ok:true });
  }

  const name  = String(body.name  || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = normalisePhone(body.phone);

  if(!name || !email || !phone || !body.capital_band || !body.consent){
    return res.status(400).json({ ok:false, error:'Missing required fields' });
  }
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){
    return res.status(400).json({ ok:false, error:'Invalid email' });
  }

  const [firstName, ...rest] = name.split(' ');
  const lastName = rest.join(' ');

  const payload = {
    name, firstName, lastName, email, phone,
    capital_band: body.capital_band,
    province: body.province || '',
    source: 'FR Plus Anchor Model LP',
    calc_portfolio_value: body.calc_portfolio_value || '',
    calc_fee_pct:         body.calc_fee_pct || '',
    calc_projected_leak:  body.calc_projected_leak || '',
    utm_source:   body.utm_source   || '',
    utm_medium:   body.utm_medium   || '',
    utm_campaign: body.utm_campaign || '',
    utm_content:  body.utm_content  || '',
    utm_term:     body.utm_term     || '',
    fbclid: body.fbclid || '',
    gclid:  body.gclid  || '',
    page_url: body.page_url || '',
    consent: true,
    submitted_at: body.submitted_at || new Date().toISOString()
  };

  // Required, blocking: the lead sheet is the system of record. Nothing below
  // this point runs unless this write succeeds, and if it fails the request
  // fails loudly rather than silently dropping a real lead.
  const sheetUrl = process.env.SHEET_WEBHOOK_URL || process.env.GHL_WEBHOOK_URL;
  if(!sheetUrl){
    console.error('SHEET_WEBHOOK_URL is not set');
    return res.status(500).json({ ok:false, error:'Lead endpoint not configured' });
  }

  try{
    const sheetRes = await fetch(sheetUrl, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });
    if(!sheetRes.ok){
      console.error('Sheet webhook returned', sheetRes.status);
      return res.status(502).json({ ok:false, error:'Could not record the lead' });
    }
  }catch(err){
    console.error('Sheet webhook error', err);
    return res.status(502).json({ ok:false, error:'Could not reach the lead store' });
  }

  // Optional fan-out, all concurrent: each leg is independently configured,
  // already swallows its own errors above, and none can block or slow the
  // response beyond the single slowest configured leg.
  await Promise.allSettled([
    notifyMetaCapi(payload),
    notifyTelegram(payload),
    notifyCrm(payload)
  ]);

  return res.status(200).json({ ok:true });
};
