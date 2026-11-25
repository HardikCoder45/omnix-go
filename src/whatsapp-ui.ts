import { createRequire } from "node:module";
import type { Express, Request, RequestHandler } from "express";
import type { WhatsAppBridge } from "./whatsapp-bridge.js";

/**
 * Loopback AND raw Host header are required: the cloudflared tunnel reaches the
 * local server via loopback too, so checking socket.remoteAddress alone is NOT
 * sufficient to keep pairing codes private.
 */
export function isPrivateWhatsAppRequest(
  req: Pick<Request, "socket" | "headers">,
  port: number,
): boolean {
  const address = req.socket.remoteAddress ?? "";
  const host = String(req.headers.host ?? "").toLowerCase();
  const isLoopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
  const isLocalHost = ["localhost:", "127.0.0.1:", "[::1]:"].some(
    (prefix) => host === prefix + port,
  );
  const forwarded = Object.keys(req.headers).some((key) => key.toLowerCase().startsWith("x-forwarded-"))
    || req.headers.forwarded !== undefined;
  return isLoopback && isLocalHost && !forwarded;
}

const html = [
  "<!doctype html><html lang='en'><head><meta charset='utf-8'>",
  "<meta name='viewport' content='width=device-width, initial-scale=1'>",
  "<title>OmniX Go | WhatsApp</title>",
  "<style>",
  ":root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color-scheme:dark;background:#0a1018;color:#e9f0f7}",
  "*{box-sizing:border-box}body{max-width:850px;margin:36px auto;padding:0 22px}",
  "header{display:flex;justify-content:space-between;align-items:center;gap:12px}",
  "h1{font-size:27px;margin:7px 0}h2{font-size:18px}p{line-height:1.55;color:#a5b6ca}",
  "a{color:#71e6cc}small{color:#97aabf}main{display:grid;gap:20px;margin-top:25px}",
  "section{border:1px solid #28374a;border-radius:18px;background:#111c2a;padding:22px}",
  "button{background:#24d5b5;border:0;border-radius:9px;color:#09202a;font-weight:700;padding:12px 16px;cursor:pointer}",
  "button.secondary{background:#24364a;color:#e9f0f7}button:disabled{opacity:.4;cursor:default}",
  "#qr{width:290px;max-width:100%;background:white;border-radius:12px;padding:13px;margin-top:15px}",
  ".message{border:1px solid #384858;padding:16px;border-radius:12px;margin:12px 0}",
  ".message pre{white-space:pre-wrap;word-break:break-word;font:inherit;color:#fff}",
  ".message strong{overflow-wrap:anywhere}#feedback{color:#ffd590;min-height:1.5em}",
  "</style></head><body>",
  "<header><div><small>OMNIX GO / LOCAL DEVICE</small><h1>WhatsApp linking</h1></div>",
  "<a href='/dashboard'>Back to dashboard</a></header><main>",
  "<section><h2>Device connection</h2><p id='status'>Not started</p>",
  "<p>QR linking is available only on this computer. Start the local bridge, then scan with WhatsApp on your phone under Linked devices. Nothing links until you scan.</p>",
  "<p><strong>Important:</strong> This uses an unofficial WhatsApp Web library, not Meta’s supported API. Linking may involve service restrictions or account risk. For business deployments, use the official WhatsApp Cloud API.</p>",
  "<button id='start'>Start QR linking</button> <button id='stop' class='secondary'>Stop bridge</button>",
  "<div><img id='qr' alt='WhatsApp device-link QR code' hidden></div>",
  "<p><small>QR codes are short-lived and never appear in MCP tool results or public OmniX URLs. Stopping keeps local session files; revoke in WhatsApp > Linked devices.</small></p></section>",
  "<section><h2>Approval inbox</h2>",
  "<p>Messages prepared via MCP appear here with their exact phone number and text. Approving only authorizes that draft; it does not send. Sending requires a later explicit MCP command.</p>",
  "<div id='drafts'></div></section><p id='feedback' role='status'></p></main>",
  "<script>",
  "const api='/api/whatsapp'; const message=document.getElementById('feedback');",
  "const start=document.getElementById('start'); const stop=document.getElementById('stop');",
  "const status=document.getElementById('status'); const qr=document.getElementById('qr');",
  "async function request(url, method='GET', data) {",
  "  const response=await fetch(api+url,{method,cache:'no-store',credentials:'same-origin',",
  "    headers:{'Content-Type':'application/json','X-OmniX-Action':'1'},body:data?JSON.stringify(data):undefined});",
  "  const result=await response.json(); if(!response.ok)throw new Error(result.error||'Action failed'); return result;",
  "}",
  "async function refresh(){",
  " try{const state=await request('/status');status.textContent='Status: '+state.phase;",
  " start.disabled=['starting','qr','ready'].includes(state.phase); stop.disabled=state.phase==='idle';",
  " qr.hidden=!state.qrAvailable;if(state.qrAvailable)qr.src=api+'/qr?t='+Date.now();",
  " const entries=await request('/drafts'); const parent=document.getElementById('drafts');parent.replaceChildren();",
  " if(!entries.drafts.length){const p=document.createElement('p');p.textContent='No pending message drafts.';parent.append(p);}",
  " entries.drafts.forEach(d=>{const card=document.createElement('div');card.className='message';",
  " const number=document.createElement('strong');number.textContent=d.recipient;",
  " const contents=document.createElement('pre');contents.textContent=d.content;",
  " const expiry=document.createElement('small');expiry.textContent='Expires: '+new Date(d.expiresAt).toLocaleTimeString();",
  " const button=document.createElement('button');button.textContent=d.approved?'Approved — awaiting explicit send':'Approve exact message';",
  " button.disabled=d.approved;button.addEventListener('click',async()=>{try{await request('/approve','POST',{id:d.id});message.textContent='Approved. Only an explicit MCP send of this request ID can deliver it.';await refresh()}catch(e){message.textContent=e.message}});",
  " card.append(number,contents,expiry,document.createElement('br'),button);parent.append(card);});",
  " }catch(e){message.textContent=e.message;}",
  "}",
  "start.addEventListener('click',async()=>{try{await request('/start','POST');message.textContent='Linking started. Scan QR only if you want to link this account.';await refresh()}catch(e){message.textContent=e.message}});",
  "stop.addEventListener('click',async()=>{try{await request('/stop','POST');message.textContent='Bridge stopped; no messages sent.';await refresh()}catch(e){message.textContent=e.message}});",
  "void refresh();setInterval(refresh,3000);",
  "</script></body></html>",
].join("\n");

export function mountWhatsAppRoutes(
  app: Express,
  bridge: WhatsAppBridge,
  options: {
    port: number;
    dashboardAuth: RequestHandler;
    dashboardMutation: RequestHandler;
  },
): void {
  const onlyLocal: RequestHandler = (req, res, next) => {
    if (!isPrivateWhatsAppRequest(req, options.port)) {
      res.status(403).json({ error: "whatsapp_local_access_only" });
      return;
    }
    next();
  };
  const checkActionOrigin: RequestHandler = (req, res, next) => {
    const expected = "http://" + req.headers.host;
    if (req.header("origin") !== expected) {
      res.status(403).json({ error: "local_origin_required" });
      return;
    }
    next();
  };
  const readGuards = [onlyLocal, options.dashboardAuth];
  const writeGuards = [onlyLocal, options.dashboardAuth, options.dashboardMutation, checkActionOrigin];

  app.get("/dashboard/whatsapp", ...readGuards, (_req, res) => {
    res.setHeader("Content-Security-Policy",
      "default-src 'none'; img-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    res.type("html").send(html);
  });
  app.get("/api/whatsapp/status", ...readGuards, (_req, res) => {
    res.json(bridge.status());
  });
  app.get("/api/whatsapp/drafts", ...readGuards, (_req, res) => {
    res.json({ drafts: bridge.pendingDrafts() });
  });
  app.get("/api/whatsapp/qr", ...readGuards, async (_req, res) => {
    const rawQr = bridge.getQrText();
    if (!rawQr) {
      res.status(404).json({ error: "qr_not_ready_or_expired" });
      return;
    }
    try {
      const require = createRequire(import.meta.url);
      const packageName = "qrcode";
      const qrLibrary = require(packageName) as {
        toString(data: string, options: object): Promise<string>;
      };
      const svg = await qrLibrary.toString(rawQr, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.type("image/svg+xml").send(svg);
    } catch {
      res.status(503).json({ error: "qr_renderer_unavailable_install_qrcode" });
    }
  });
  app.post("/api/whatsapp/start", ...writeGuards, async (_req, res) => {
    try {
      res.json(await bridge.start());
    } catch {
      res.status(503).json({ error: "whatsapp_bridge_start_failed" });
    }
  });
  app.post("/api/whatsapp/stop", ...writeGuards, async (_req, res) => {
    try {
      await bridge.stop();
      res.json(bridge.status());
    } catch {
      res.status(503).json({ error: "whatsapp_bridge_stop_failed" });
    }
  });
  app.post("/api/whatsapp/approve", ...writeGuards, (req, res) => {
    try {
      const id = req.body?.id;
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) {
        res.status(400).json({ error: "invalid_approval_id" });
        return;
      }
      bridge.approveSend(id);
      res.json({ approved: true, sent: false });
    } catch {
      res.status(400).json({ error: "approval_expired_or_unavailable" });
    }
  });
}
