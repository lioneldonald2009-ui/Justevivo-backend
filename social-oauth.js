import crypto from "crypto";

const SB_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY || "";
const SITE_URL = process.env.SITE_URL || "https://justevivo.pages.dev/";
const API_URL = String(process.env.API_PUBLIC_URL || "https://justevivo-backend.onrender.com").replace(/\/+$/, "");
const TOKEN_KEY = crypto.createHash("sha256").update(String(process.env.SOCIAL_TOKEN_ENCRYPTION_KEY || "")).digest();

const PROVIDERS = {
  meta: {
    label: "Meta (Facebook + Instagram)",
    client: "META_APP_ID", secret: "META_APP_SECRET",
    authorize: "https://www.facebook.com/v23.0/dialog/oauth",
    token: "https://graph.facebook.com/v23.0/oauth/access_token",
    scopes: ["pages_show_list","pages_read_engagement","pages_manage_posts","instagram_basic","instagram_content_publish"]
  },
  tiktok: {
    label: "TikTok",
    client: "TIKTOK_CLIENT_KEY", secret: "TIKTOK_CLIENT_SECRET",
    authorize: "https://www.tiktok.com/v2/auth/authorize/",
    token: "https://open.tiktokapis.com/v2/oauth/token/",
    scopes: ["user.info.basic","video.publish"]
  },
  youtube: {
    label: "YouTube",
    client: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/youtube.upload"]
  },
  linkedin: {
    label: "LinkedIn",
    client: "LINKEDIN_CLIENT_ID", secret: "LINKEDIN_CLIENT_SECRET",
    authorize: "https://www.linkedin.com/oauth/v2/authorization",
    token: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["openid","profile","w_member_social"]
  }
};

function encrypt(value) {
  if (!process.env.SOCIAL_TOKEN_ENCRYPTION_KEY) throw new Error("SOCIAL_TOKEN_ENCRYPTION_KEY manquante.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", TOKEN_KEY, iv);
  const data = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}
function decrypt(value) {
  const [iv, tag, data] = String(value || "").split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", TOKEN_KEY, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
function dbHeaders(extra = {}) {
  const h = { apikey: SB_SERVICE, "Content-Type": "application/json", ...extra };
  if (SB_SERVICE.startsWith("eyJ")) h.Authorization = "Bearer " + SB_SERVICE;
  return h;
}
async function db(path, options = {}) {
  const response = await fetch(SB_URL + "/rest/v1/" + path, { ...options, headers: dbHeaders(options.headers || {}) });
  if (!response.ok) throw new Error("Erreur de stockage OAuth (" + response.status + ").");
  return response.status === 204 ? [] : response.json().catch(() => []);
}
function callback(provider) { return API_URL + "/api/social/callback/" + provider; }
function config(provider) {
  const p = PROVIDERS[provider];
  return p && process.env[p.client] && process.env[p.secret] && Boolean(process.env.SOCIAL_TOKEN_ENCRYPTION_KEY);
}
function safeRedirect(value) {
  try { const u = new URL(value || SITE_URL); return u.origin === new URL(SITE_URL).origin ? u.toString() : SITE_URL; }
  catch { return SITE_URL; }
}
function redirectPage(message, ok = false, res) {
  const u = new URL(SITE_URL);
  u.searchParams.set("social_connection", ok ? "success" : "error");
  u.searchParams.set("social_message", message.slice(0, 180));
  res.redirect(302, u.toString());
}
async function tokenRequest(url, params, json = false) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": json ? "application/json" : "application/x-www-form-urlencoded" },
    body: json ? JSON.stringify(params) : new URLSearchParams(params)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw new Error(body.error_description || body.error || "Échange OAuth refusé.");
  return body;
}
async function accountDetails(provider, accessToken, idToken) {
  if (provider === "meta") {
    const r = await fetch("https://graph.facebook.com/v23.0/me?fields=id,name&access_token=" + encodeURIComponent(accessToken));
    const d = await r.json(); return { id: d.id || null, name: d.name || "Compte Meta" };
  }
  if (provider === "tiktok") {
    const r = await fetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name", { headers: { Authorization: "Bearer " + accessToken } });
    const d = await r.json(); return { id: d.data?.user?.open_id || null, name: d.data?.user?.display_name || "Compte TikTok" };
  }
  if (provider === "linkedin") {
    const r = await fetch("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: "Bearer " + accessToken } });
    const d = await r.json(); return { id: d.sub || null, name: d.name || "Compte LinkedIn" };
  }
  try {
    const payload = JSON.parse(Buffer.from(String(idToken || "").split(".")[1], "base64url").toString());
    return { id: payload.sub || null, name: payload.name || payload.email || "Compte YouTube" };
  } catch { return { id: null, name: "Compte YouTube" }; }
}

export function registerSocialOAuth(app, requireUser) {
  app.get("/api/social/providers", requireUser, async (req, res) => {
    try {
      const rows = await db("social_connections?select=provider,account_name,connected_at,token_expires_at&user_id=eq." + encodeURIComponent(req.user.id));
      const connected = Object.fromEntries(rows.map(r => [r.provider, { connected: true, accountName: r.account_name, connectedAt: r.connected_at }]));
      res.json({ providers: Object.keys(PROVIDERS).map(id => ({ id, label: PROVIDERS[id].label, configured: config(id), ...(connected[id] || { connected: false }) })) });
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  app.get("/api/social/connect/:provider", requireUser, async (req, res) => {
    const provider = req.params.provider, p = PROVIDERS[provider];
    if (!p) return res.status(404).json({ error: "Réseau inconnu." });
    if (!config(provider)) return res.status(503).json({ error: "Configuration développeur manquante pour " + p.label + "." });
    try {
      const state = crypto.randomBytes(32).toString("base64url");
      const redirectTo = safeRedirect(req.query.redirect);
      await db("social_oauth_states", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
        state, user_id: req.user.id, provider, redirect_to: redirectTo,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
      }) });
      const u = new URL(p.authorize);
      const params = { response_type: "code", client_id: process.env[p.client], redirect_uri: callback(provider), state, scope: p.scopes.join(provider === "meta" ? "," : " ") };
      if (provider === "tiktok") { delete params.client_id; params.client_key = process.env[p.client]; }
      if (provider === "youtube") { params.access_type = "offline"; params.prompt = "consent"; params.include_granted_scopes = "true"; }
      for (const [k,v] of Object.entries(params)) u.searchParams.set(k, String(v));
      if (String(req.query.json || "") === "1") return res.json({ url: u.toString() });
      res.redirect(302, u.toString());
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  app.get("/api/social/callback/:provider", async (req, res) => {
    const provider = req.params.provider, p = PROVIDERS[provider];
    if (!p) return res.status(404).send("Réseau inconnu.");
    if (req.query.error) return redirectPage(p.label + " : autorisation refusée.", false, res);
    const state = String(req.query.state || ""), code = String(req.query.code || "");
    if (!state || !code || !config(provider)) return redirectPage("Connexion " + p.label + " incomplète.", false, res);
    try {
      const states = await db("social_oauth_states?state=eq." + encodeURIComponent(state) + "&provider=eq." + provider, { method: "DELETE", headers: { Prefer: "return=representation" } });
      const saved = states[0];
      if (!saved || new Date(saved.expires_at).getTime() < Date.now()) return redirectPage("Lien de connexion expiré. Réessayez.", false, res);
      const params = { grant_type: "authorization_code", code, redirect_uri: callback(provider), client_id: process.env[p.client], client_secret: process.env[p.secret] };
      if (provider === "tiktok") { delete params.client_id; params.client_key = process.env[p.client]; }
      const tokens = provider === "meta"\n        ? await (async () => { const u = new URL(p.token); for (const [k,v] of Object.entries(params)) u.searchParams.set(k, String(v)); const r = await fetch(u); const d = await r.json(); if (!r.ok || d.error) throw new Error(d.error?.message || "Échange Meta refusé."); return d; })()\n        : await tokenRequest(p.token, params, false);
      const access = tokens.access_token || tokens.data?.access_token;
      const refresh = tokens.refresh_token || tokens.data?.refresh_token || null;
      if (!access) throw new Error("Le réseau n'a pas retourné de jeton.");
      const account = await accountDetails(provider, access, tokens.id_token);
      const scopes = String(tokens.scope || tokens.data?.scope || p.scopes.join(" ")).split(/[ ,]+/).filter(Boolean);
      const row = {
        user_id: saved.user_id, provider, account_id: account.id, account_name: account.name,
        access_token_enc: encrypt(access), refresh_token_enc: refresh ? encrypt(refresh) : null,
        token_expires_at: tokens.expires_in ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString() : null,
        scopes, updated_at: new Date().toISOString()
      };
      await db("social_connections?on_conflict=user_id,provider", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
      redirectPage(p.label + " connecté.", true, res);
    } catch (e) {
      console.error("OAuth " + provider + ":", e.message);
      redirectPage("Connexion " + p.label + " impossible. Vérifiez les autorisations et réessayez.", false, res);
    }
  });

  app.delete("/api/social/disconnect/:provider", requireUser, async (req, res) => {
    const provider = req.params.provider;
    if (!PROVIDERS[provider]) return res.status(404).json({ error: "Réseau inconnu." });
    try {
      await db("social_connections?user_id=eq." + encodeURIComponent(req.user.id) + "&provider=eq." + provider, { method: "DELETE" });
      res.json({ ok: true });
    } catch (e) { res.status(503).json({ error: e.message }); }
  });
}
