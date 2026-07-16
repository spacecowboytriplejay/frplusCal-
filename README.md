# FR+ — The Anchor Model

Static landing page for FR Plus Investments with a lead-capture form that posts to
GoHighLevel through a Vercel serverless function. Deploys on Vercel. Every push to
`main` auto-deploys, and the `/api` folder auto-provisions as a function.

## Files
- `index.html`     — full page (styles + JS inline), the form, and all CTA routing
- `api/lead.js`    — serverless function: validates the lead, forwards to GoHighLevel, optional Meta CAPI
- `og-frplus.png`  — 1200x630 social preview card
- `vercel.json`    — clean URLs, security headers, caching
- `.gitignore`

## 1. Replace the placeholder tokens (before DNS cutover)
- `REPLACE-WITH-FRPLUS-DOMAIN`  — 4 places in index.html (canonical, og:url, og:image, twitter:image)
- `REPLACE-WITH-META-PIXEL-ID`  — 2 places in index.html (pixel init + noscript). Leave as-is only if you are not running the pixel yet; the page still works.

## 2. Set environment variables in Vercel
Project > Settings > Environment Variables:
- `GHL_WEBHOOK_URL`   (required)  the inbound-webhook URL from your GoHighLevel workflow
- `META_PIXEL_ID`     (optional)  turns on server-side Meta Conversions API
- `META_CAPI_TOKEN`   (optional)  Conversions API token, pairs with META_PIXEL_ID
Redeploy after adding them so the function picks them up.

## 3. GoHighLevel setup
1. Automation > Workflows > Create Workflow.
2. Add Trigger > Inbound Webhook. Copy the generated URL. Paste it as `GHL_WEBHOOK_URL` in Vercel.
3. Send one test submission from the live form so GHL captures a sample payload.
4. Add action Create/Update Contact. Map name, email, phone from the payload. Map
   capital_band, calc_projected_leak, utm_source, utm_campaign, etc. to custom fields.
5. Add your speed-to-lead actions: instant WhatsApp/SMS + email, then adviser assignment.
   The whole point is first contact within minutes, not hours.

## 4. Deploy
Push to the connected GitHub repo. Vercel builds in ~40s and provisions `/api/lead`
automatically. No build command, no output directory.

## Launch gate (do not skip)
The page is not live because it renders. It is live when a real test submission lands
in GoHighLevel and fires the first automated touch, and (if the pixel is set) a Lead
event shows in Meta Events Manager / Test Events. Test the pipe end to end before you
send a single rand of ad traffic at it.

## Notes still open (from the build)
- Map region markers are placeholder geography. Swap for real asset locations before launch.
- Calculator is generic (fees/inflation only). Keep it that way until Key Individual sign-off.
