// FR+ lead handler (Vercel serverless function).
// Receives the landing-page form POST, forwards it to GoHighLevel,
// and optionally sends a server-side Meta Conversions API event.
//
// Set these in Vercel > Project > Settings > Environment Variables:
//   GHL_WEBHOOK_URL   (required)  Inbound-webhook URL from your GoHighLevel workflow trigger
//   META_PIXEL_ID     (optional)  Enables server-side Meta CAPI (recommended once the pixel is live)
//   META_CAPI_TOKEN   (optional)  Conversions API access token, pairs with META_PIXEL_ID
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

  const ghlUrl = process.env.GHL_WEBHOOK_URL;
  if(!ghlUrl){
    console.error('GHL_WEBHOOK_URL is not set');
    return res.status(500).json({ ok:false, error:'Lead endpoint not configured' });
  }

  try{
    const ghlRes = await fetch(ghlUrl, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });
    if(!ghlRes.ok){
      console.error('GHL webhook returned', ghlRes.status);
      return res.status(502).json({ ok:false, error:'CRM rejected the lead' });
    }
  }catch(err){
    console.error('GHL webhook error', err);
    return res.status(502).json({ ok:false, error:'Could not reach CRM' });
  }

  // Optional: server-side Meta Conversions API, fires alongside the browser pixel
  const pixelId   = process.env.META_PIXEL_ID;
  const capiToken = process.env.META_CAPI_TOKEN;
  if(pixelId && capiToken){
    try{
      const fbc = body.fbclid ? ('fb.1.' + Date.now() + '.' + body.fbclid) : undefined;
      await fetch('https://graph.facebook.com/v19.0/' + pixelId + '/events?access_token=' + capiToken, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({
          data:[{
            event_name:'Lead',
            event_time: Math.floor(Date.now()/1000),
            action_source:'website',
            event_source_url: body.page_url || undefined,
            user_data:{
              em:[ sha256(email) ],
              ph:[ sha256(phone) ],
              ...(fbc ? { fbc } : {})
            }
          }]
        })
      });
    }catch(err){
      console.error('Meta CAPI error (non-blocking)', err);
    }
  }

  return res.status(200).json({ ok:true });
};
