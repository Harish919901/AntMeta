const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// Admin secret to generate magic links (set in Render env vars)
const ADMIN_SECRET = process.env.ADMIN_SECRET || "digibull-admin-2024";

// Default link lifetime: 2 hours (in milliseconds)
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

// In-memory store for magic links
// { token: { createdAt, expiresAt, label, accessCount } }
const magicLinks = new Map();

// Read the HTML file once at startup
const htmlFilePath = path.join(__dirname, "antmeta-platform.html");
const platformHTML = fs.readFileSync(htmlFilePath, "utf-8");

// ─── Middleware ───────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Routes ──────────────────────────────────────────────────

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Generate a magic link (protected by admin secret)
app.post("/api/generate", (req, res) => {
  const { secret, label, ttlMinutes } = req.body;

  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: "Invalid admin secret" });
  }

  const token = crypto.randomUUID();
  const ttl = ttlMinutes ? ttlMinutes * 60 * 1000 : DEFAULT_TTL_MS;
  const now = Date.now();

  magicLinks.set(token, {
    createdAt: now,
    expiresAt: now + ttl,
    label: label || "Unnamed",
    accessCount: 0,
  });

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const magicUrl = `${baseUrl}/view/${token}`;
  const expiresAt = new Date(now + ttl).toISOString();

  console.log(`[LINK CREATED] ${magicUrl} — expires ${expiresAt}`);

  res.json({
    url: magicUrl,
    token,
    expiresAt,
    ttlMinutes: ttl / 60000,
  });
});

// List all active links (protected)
app.post("/api/links", (req, res) => {
  const { secret } = req.body;

  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: "Invalid admin secret" });
  }

  const now = Date.now();
  const links = [];

  for (const [token, data] of magicLinks) {
    const remaining = data.expiresAt - now;
    if (remaining > 0) {
      links.push({
        token,
        label: data.label,
        expiresAt: new Date(data.expiresAt).toISOString(),
        remainingMinutes: Math.round(remaining / 60000),
        accessCount: data.accessCount,
      });
    }
  }

  res.json({ activeLinks: links });
});

// Revoke a magic link (protected)
app.post("/api/revoke", (req, res) => {
  const { secret, token } = req.body;

  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: "Invalid admin secret" });
  }

  if (magicLinks.has(token)) {
    magicLinks.delete(token);
    return res.json({ revoked: true });
  }

  res.status(404).json({ error: "Link not found" });
});

// ─── Magic Link Viewer ──────────────────────────────────────

app.get("/view/:token", (req, res) => {
  const { token } = req.params;
  const link = magicLinks.get(token);

  if (!link) {
    return res.status(404).send(expiredPage("This link does not exist."));
  }

  const now = Date.now();
  if (now > link.expiresAt) {
    magicLinks.delete(token);
    return res.status(410).send(expiredPage("This link has expired."));
  }

  // Track access
  link.accessCount++;

  // Inject a small expiry banner into the HTML
  const remaining = link.expiresAt - now;
  const mins = Math.ceil(remaining / 60000);
  const banner = `
<div id="magic-link-banner" style="
  position:fixed; top:0; left:0; right:0; z-index:99999;
  background:linear-gradient(90deg,#0072ff,#00c6ff);
  color:#fff; text-align:center; padding:8px 16px;
  font-family:Inter,sans-serif; font-size:13px;
  box-shadow:0 2px 8px rgba(0,0,0,0.3);
">
  Preview link — expires in ~${mins} min&nbsp;|&nbsp;
  <span style="opacity:0.7">Shared by DigiBull</span>
  <script>
    (function(){
      var exp = ${link.expiresAt};
      setInterval(function(){
        var left = exp - Date.now();
        if(left <= 0){
          document.getElementById('magic-link-banner').innerHTML =
            '<b>This preview link has expired.</b>';
          document.getElementById('magic-link-banner').style.background = '#c0392b';
        } else {
          var m = Math.ceil(left/60000);
          document.getElementById('magic-link-banner').innerHTML =
            'Preview link — expires in ~' + m + ' min | <span style=\"opacity:0.7\">Shared by DigiBull</span>';
        }
      }, 30000);
    })();
  </script>
</div>
<div style="height:36px"></div>
`;

  // Inject banner right after <body>
  const injected = platformHTML.replace(/<body[^>]*>/i, (match) => match + banner);
  res.send(injected);
});

// ─── Admin Dashboard (simple HTML) ──────────────────────────

app.get("/admin", (_req, res) => {
  res.send(adminPage());
});

// ─── Root ────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.redirect("/admin");
});

// ─── Cleanup expired links every 10 minutes ─────────────────

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [token, data] of magicLinks) {
    if (now > data.expiresAt) {
      magicLinks.delete(token);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`[CLEANUP] Removed ${cleaned} expired link(s)`);
}, 10 * 60 * 1000);

// ─── Start Server ────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  DigiBull Magic Link Server`);
  console.log(`  ──────────────────────────`);
  console.log(`  Running on port ${PORT}`);
  console.log(`  Admin panel: http://localhost:${PORT}/admin`);
  console.log(`  Admin secret: ${ADMIN_SECRET.slice(0, 4)}****\n`);
});

// ─── HTML Templates ─────────────────────────────────────────

function expiredPage(message) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><title>Link Expired — DigiBull</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#04101E;font-family:Inter,sans-serif;color:#fff}
  .box{text-align:center;padding:48px;border-radius:16px;
    background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);
    max-width:440px}
  h1{font-size:22px;margin-bottom:12px;color:#e74c3c}
  p{font-size:15px;opacity:0.7;line-height:1.6}
  .logo{font-size:28px;font-weight:800;margin-bottom:24px;
    background:linear-gradient(135deg,#00c6ff,#0072ff);-webkit-background-clip:text;
    -webkit-text-fill-color:transparent}
</style>
</head><body>
<div class="box">
  <div class="logo">DigiBull</div>
  <h1>${message}</h1>
  <p>This preview link is no longer available.<br>
  Contact the sender for a new link.</p>
</div>
</body></html>`;
}

function adminPage() {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DigiBull Magic Link Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{min-height:100vh;background:#04101E;font-family:Inter,sans-serif;color:#fff;
    display:flex;flex-direction:column;align-items:center;padding:48px 20px;
    background-image:radial-gradient(ellipse at 50% 0%,rgba(0,114,255,0.08) 0%,transparent 60%)}
  .container{width:100%;max-width:500px}
  .header{text-align:center;margin-bottom:40px}
  .header-logo{width:72px;height:72px;margin:0 auto 14px}
  .logo{font-size:32px;font-weight:800;letter-spacing:-0.5px;
    background:linear-gradient(135deg,#00c6ff,#0072ff);-webkit-background-clip:text;
    -webkit-text-fill-color:transparent;margin-bottom:6px}
  .sub{font-size:14px;opacity:0.45;font-weight:400}
  .card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);
    border-radius:16px;padding:28px;margin-bottom:20px;
    backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
  .card h3{font-size:16px;font-weight:700;margin-bottom:4px;color:#fff}
  .card .card-sub{font-size:12px;opacity:0.35;margin-bottom:16px}
  label{display:block;font-size:12px;font-weight:600;opacity:0.5;margin-bottom:6px;
    margin-top:18px;text-transform:uppercase;letter-spacing:0.5px}
  label:first-of-type{margin-top:0}
  input,select{width:100%;padding:11px 14px;border-radius:10px;
    border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);
    color:#fff;font-size:14px;font-family:Inter,sans-serif;outline:none;
    transition:border-color 0.2s,box-shadow 0.2s}
  input:focus,select:focus{border-color:rgba(0,114,255,0.5);
    box-shadow:0 0 0 3px rgba(0,114,255,0.1)}
  input::placeholder{color:rgba(255,255,255,0.25)}
  select option{background:#0a1929;color:#fff}
  .btn-primary{width:100%;margin-top:22px;padding:12px 24px;border:none;border-radius:10px;
    background:linear-gradient(135deg,#0072ff,#00c6ff);color:#fff;font-size:14px;
    cursor:pointer;font-weight:700;letter-spacing:0.3px;
    transition:opacity 0.2s,transform 0.15s}
  .btn-primary:hover{opacity:0.9;transform:translateY(-1px)}
  .btn-primary:active{transform:translateY(0)}
  .btn-secondary{margin-top:10px;padding:9px 20px;border:none;border-radius:8px;
    background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);
    color:#fff;font-size:13px;cursor:pointer;font-weight:600;
    transition:background 0.2s}
  .btn-secondary:hover{background:rgba(255,255,255,0.1)}
  .result{margin-top:18px;padding:16px;background:rgba(0,114,255,0.08);
    border:1px solid rgba(0,114,255,0.2);border-radius:12px;
    word-break:break-all;display:none}
  .result a{color:#00c6ff;text-decoration:none;font-weight:600;font-size:13px}
  .result a:hover{text-decoration:underline}
  .result .exp{font-size:11px;opacity:0.4;margin-top:8px}
  #links-list{margin-top:14px}
  .link-item{padding:14px 16px;background:rgba(255,255,255,0.03);
    border:1px solid rgba(255,255,255,0.06);border-radius:12px;
    margin-bottom:10px;font-size:13px;display:flex;justify-content:space-between;
    align-items:center;transition:background 0.2s}
  .link-item:hover{background:rgba(255,255,255,0.05)}
  .link-item .info{flex:1}
  .link-item .label{font-weight:700;color:#00c6ff}
  .link-item .meta{opacity:0.4;font-size:11px;margin-top:4px}
  .link-actions{display:flex;gap:6px}
  .copy-btn{background:rgba(0,114,255,0.15);border:1px solid rgba(0,114,255,0.25);
    color:#00c6ff;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:12px;
    font-weight:600;transition:background 0.2s}
  .copy-btn:hover{background:rgba(0,114,255,0.25)}
  .revoke-btn{background:rgba(231,76,60,0.12);border:1px solid rgba(231,76,60,0.25);
    color:#e74c3c;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:12px;
    font-weight:600;transition:background 0.2s}
  .revoke-btn:hover{background:rgba(231,76,60,0.22)}
  .empty-state{text-align:center;padding:20px;opacity:0.3;font-size:13px}
  .divider{height:1px;background:rgba(255,255,255,0.06);margin:20px 0}
</style>
</head><body>

<div class="container">
  <div class="header">
    <img src="/logo.png" alt="DigiBull" class="header-logo">
    <div class="logo">DigiBull</div>
    <p class="sub">Magic Link Admin</p>
  </div>

  <div class="card">
    <h3>Generate New Link</h3>
    <div class="card-sub">Create a temporary preview link for your client</div>
    <label>Admin Secret</label>
    <input type="password" id="secret" placeholder="Enter admin secret">
    <label>Client / Label</label>
    <input type="text" id="label" placeholder="e.g. Acme Corp Demo">
    <label>Expires in</label>
    <select id="ttl">
      <option value="30">30 minutes</option>
      <option value="60">1 hour</option>
      <option value="120" selected>2 hours</option>
      <option value="240">4 hours</option>
      <option value="480">8 hours</option>
      <option value="1440">24 hours</option>
    </select>
    <button class="btn-primary" onclick="generate()">Generate Magic Link</button>
    <div class="result" id="result"></div>
  </div>

  <div class="card">
    <h3>Active Links</h3>
    <div class="card-sub">Manage all currently active preview links</div>
    <button class="btn-secondary" onclick="loadLinks()">Refresh Links</button>
    <div id="links-list"><p class="empty-state">Click refresh to load active links</p></div>
  </div>
</div>

<script>
function getSecret(){ return document.getElementById('secret').value; }

async function generate(){
  const btn = document.querySelector('.btn-primary');
  btn.textContent = 'Generating...';
  btn.disabled = true;
  try {
    const res = await fetch('/api/generate',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        secret: getSecret(),
        label: document.getElementById('label').value,
        ttlMinutes: parseInt(document.getElementById('ttl').value)
      })
    });
    const data = await res.json();
    const el = document.getElementById('result');
    if(res.ok){
      el.style.display='block';
      el.innerHTML = '<a href="'+data.url+'" target="_blank">'+data.url+'</a>'
        +'<div class="exp">Expires: '+data.expiresAt+' ('+data.ttlMinutes+' min)</div>';
    } else {
      el.style.display='block';
      el.innerHTML = '<span style="color:#e74c3c">'+data.error+'</span>';
    }
  } finally {
    btn.textContent = 'Generate Magic Link';
    btn.disabled = false;
  }
}

async function loadLinks(){
  const res = await fetch('/api/links',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ secret: getSecret() })
  });
  const data = await res.json();
  const el = document.getElementById('links-list');
  if(!res.ok){ el.innerHTML='<p style="color:#e74c3c;text-align:center;padding:16px">'+data.error+'</p>'; return; }
  if(!data.activeLinks.length){ el.innerHTML='<p class="empty-state">No active links</p>'; return; }
  el.innerHTML = data.activeLinks.map(l =>
    '<div class="link-item"><div class="info">'
    +'<div class="label">'+l.label+'</div>'
    +'<div class="meta">'+l.remainingMinutes+' min left · '+l.accessCount+' views</div>'
    +'</div>'
    +'<div class="link-actions">'
    +'<button class="copy-btn" onclick="navigator.clipboard.writeText(location.origin+\\'/view/'+l.token+'\\')">Copy</button>'
    +'<button class="revoke-btn" onclick="revoke(\\''+l.token+'\\')">Revoke</button>'
    +'</div></div>'
  ).join('');
}

async function revoke(token){
  await fetch('/api/revoke',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ secret: getSecret(), token })
  });
  loadLinks();
}
</script>
</body></html>`;
}
