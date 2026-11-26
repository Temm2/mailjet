import express from "express";
import pg from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const { Pool } = pg;

const MAILJET_API_KEY = process.env.MAILJET_API_KEY;
const MAILJET_API_SECRET = process.env.MAILJET_API_SECRET;
// Claude's "Add custom connector" screen only supports OAuth for auth, not a
// plain bearer token, so instead this server is only reachable at a URL that
// includes a long random secret segment: POST /mcp/<MCP_PATH_SECRET>.
// Set MCP_PATH_SECRET on your host to a long random string (e.g. `openssl
// rand -hex 24`) and use the full path (including the secret) as the
// connector URL. Anyone who doesn't have that exact URL can't call this
// server at all — there's no bare /mcp route.
const PATH_SECRET = process.env.MCP_PATH_SECRET;
if (!PATH_SECRET) {
  console.warn(
    "WARNING: MCP_PATH_SECRET is not set. Set it to a long random string before deploying for real, or this server has no access control."
  );
}

if (!MAILJET_API_KEY || !MAILJET_API_SECRET) {
  console.warn(
    "WARNING: MAILJET_API_KEY / MAILJET_API_SECRET are not set. Tool calls will fail until you set them as environment variables on your host."
  );
}

// --- Durable unsubscribe log (Postgres) + Snov.io Do-Not-Contact sync ---
//
// The /unsub route below is the real, public link every MindNote campaign
// email points recipients to. The durable source of truth for "this address
// opted out" is the Postgres row written there. A best-effort call is also
// made to push the address into Snov.io's Do-Not-Contact list immediately so
// the Snov campaigns stop right away -- but since that Snov endpoint's exact
// field names aren't publicly documented, that call may silently fail on
// Snov's side even though the opt-out itself is safely recorded here. A
// periodic reconciliation (run from the Claude session managing the
// campaign) reads unsynced rows via GET /export?token=... and makes sure
// every one of them ends up both in Snov's DNC list and in the master
// campaign CSV's sent_status column. Never remove a row here without a
// corresponding deliberate un-suppress action -- this table is an
// append-only opt-out log.
const pgPool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

const SNOV_CLIENT_ID = process.env.SNOV_CLIENT_ID;
const SNOV_CLIENT_SECRET = process.env.SNOV_CLIENT_SECRET;
const SNOV_DNC_LIST_ID = process.env.SNOV_DNC_LIST_ID; // e.g. 13255757
const EXPORT_TOKEN = process.env.EXPORT_TOKEN; // shared secret protecting /export

let snovTokenCache = { token: null, expiresAt: 0 };

async function getSnovAccessToken() {
  if (!SNOV_CLIENT_ID || !SNOV_CLIENT_SECRET) return null;
  const now = Date.now();
  if (snovTokenCache.token && snovTokenCache.expiresAt > now + 30_000) {
    return snovTokenCache.token;
  }
  const resp = await fetch("https://api.snov.io/v1/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: SNOV_CLIENT_ID,
      client_secret: SNOV_CLIENT_SECRET,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new Error(`oauth_failed status=${resp.status} body=${JSON.stringify(data).slice(0, 500)}`);
  }
  snovTokenCache = {
    token: data.access_token,
    expiresAt: now + Number(data.expires_in || 3600) * 1000,
  };
  return data.access_token;
}

async function addToSnovDnc(email) {
  if (!SNOV_CLIENT_ID || !SNOV_CLIENT_SECRET || !SNOV_DNC_LIST_ID) {
    console.error(`snov_dnc_sync email=${email} ok=false detail=snov_env_not_configured`);
    return { attempted: false, ok: false, detail: "snov_env_not_configured" };
  }
  try {
    const token = await getSnovAccessToken();
    const resp = await fetch("https://api.snov.io/v1/add-to-do-not-email-list", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        access_token: token,
        listId: Number(SNOV_DNC_LIST_ID),
        list_id: Number(SNOV_DNC_LIST_ID),
        emails: [email],
        entries: [email],
        email,
      }),
    });
    const text = await resp.text();
    // Always logged to stdout/stderr (visible in Render logs) regardless of
    // whether Postgres is reachable -- this is the fallback source of truth
    // for diagnosing sync failures when the DB can't be written to.
    if (resp.ok) {
      console.log(`snov_dnc_sync email=${email} ok=true status=${resp.status} detail=${text.slice(0, 500)}`);
    } else {
      console.error(`snov_dnc_sync email=${email} ok=false status=${resp.status} detail=${text.slice(0, 500)}`);
    }
    return { attempted: true, ok: resp.ok, status: resp.status, detail: text.slice(0, 1000) };
  } catch (err) {
    console.error(`snov_dnc_sync email=${email} ok=false error=${String(err).slice(0, 500)}`);
    return { attempted: true, ok: false, detail: String(err).slice(0, 1000) };
  }
}

async function ensureSchema() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS unsubscribes (
      email TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'link_click',
      campaign_context TEXT,
      snov_dnc_synced BOOLEAN NOT NULL DEFAULT FALSE,
      snov_dnc_detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_sync_attempt_at TIMESTAMPTZ
    );
  `);
}

function mailjetAuthHeader() {
  const token = Buffer.from(`${MAILJET_API_KEY}:${MAILJET_API_SECRET}`).toString("base64");
  return `Basic ${token}`;
}

async function mailjetFetch(path, options = {}) {
  const res = await fetch(`https://api.mailjet.com${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: mailjetAuthHeader(),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    const err = new Error(`Mailjet API error ${res.status}: ${JSON.stringify(json)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Marks an email address as unsubscribed in Mailjet: IsExcludedFromCampaigns
// on the contact record. Works whether or not the contact already exists.
async function unsubscribeEmail(email) {
  try {
    await mailjetFetch(`/v3/REST/contact/${encodeURIComponent(email)}`, {
      method: "PUT",
      body: JSON.stringify({ IsExcludedFromCampaigns: true }),
    });
  } catch (err) {
    if (err.status === 404) {
      // Contact doesn't exist in Mailjet yet — create it pre-excluded.
      await mailjetFetch("/v3/REST/contact", {
        method: "POST",
        body: JSON.stringify({ Email: email, IsExcludedFromCampaigns: true }),
      });
    } else {
      throw err;
    }
  }
}

function buildServer() {
  const server = new McpServer({ name: "mailjet-mcp-http", version: "1.0.0" });

  server.tool(
    "send_email",
    "Send a single transactional email through Mailjet",
    {
      from_email: z.string().describe("Verified sender address, e.g. publishing@mind-note.online"),
      from_name: z.string().optional(),
      to_email: z.string(),
      to_name: z.string().optional(),
      subject: z.string(),
      html: z.string().optional().describe("HTML body"),
      text: z.string().optional().describe("Plain text body"),
      reply_to_email: z.string().optional(),
    },
    async (args) => {
      const message = {
        From: { Email: args.from_email, Name: args.from_name || args.from_email },
        To: [{ Email: args.to_email, Name: args.to_name || args.to_email }],
        Subject: args.subject,
      };
      if (args.html) message.HTMLPart = args.html;
      if (args.text) message.TextPart = args.text;
      if (args.reply_to_email) message.ReplyTo = { Email: args.reply_to_email };

      const result = await mailjetFetch("/v3.1/send", {
        method: "POST",
        body: JSON.stringify({ Messages: [message] }),
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "list_contacts",
    "List contacts in the Mailjet account",
    { limit: z.number().optional(), offset: z.number().optional() },
    async (args) => {
      const limit = args.limit ?? 25;
      const offset = args.offset ?? 0;
      const result = await mailjetFetch(`/v3/REST/contact?Limit=${limit}&Offset=${offset}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_contact",
    "Get a single Mailjet contact by email address. The response includes IsExcludedFromCampaigns / UnsubscribedAt — check these before re-emailing anyone.",
    { email: z.string() },
    async (args) => {
      const result = await mailjetFetch(`/v3/REST/contact/${encodeURIComponent(args.email)}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "create_or_update_contact",
    "Create a Mailjet contact (or update it if it already exists) and optionally set its custom properties",
    {
      email: z.string(),
      name: z.string().optional(),
      properties: z
        .record(z.string())
        .optional()
        .describe("Custom contact properties, e.g. {\"first_name\": \"Tom\", \"headline\": \"...\"}"),
    },
    async (args) => {
      await mailjetFetch("/v3/REST/contact", {
        method: "POST",
        body: JSON.stringify({ Email: args.email, Name: args.name }),
      }).catch(() => null); // Mailjet errors if the contact already exists; safe to ignore here.

      if (args.properties) {
        const data = Object.entries(args.properties).map(([Name, Value]) => ({ Name, Value }));
        await mailjetFetch(`/v3/REST/contactdata/${encodeURIComponent(args.email)}`, {
          method: "PUT",
          body: JSON.stringify({ Data: data }),
        });
      }
      return { content: [{ type: "text", text: `Contact ${args.email} created/updated.` }] };
    }
  );

  server.tool(
    "unsubscribe_contact",
    "Mark an email address as unsubscribed / excluded from future campaigns in Mailjet",
    { email: z.string() },
    async (args) => {
      await unsubscribeEmail(args.email);
      return { content: [{ type: "text", text: `${args.email} marked as unsubscribed in Mailjet.` }] };
    }
  );

  server.tool(
    "delete_contact",
    "Permanently delete a contact from Mailjet by email address. Use this to free up room under a plan's contact-count limit — e.g. after a campaign send, once you no longer need the contact record for anything other than dedupe (dedupe should be tracked elsewhere before deleting). Safe to call even if the contact doesn't exist.",
    { email: z.string() },
    async (args) => {
      try {
        const contact = await mailjetFetch(`/v3/REST/contact/${encodeURIComponent(args.email)}`);
        const id = contact?.Data?.[0]?.ID;
        if (id) {
          await mailjetFetch(`/v3/REST/contact/${id}`, { method: "DELETE" });
        }
      } catch (err) {
        if (err.status !== 404) throw err;
      }
      return { content: [{ type: "text", text: `${args.email} deleted from Mailjet (or did not exist).` }] };
    }
  );

  server.tool(
    "list_campaigns",
    "List campaigns in the Mailjet account",
    { limit: z.number().optional() },
    async (args) => {
      const limit = args.limit ?? 25;
      const result = await mailjetFetch(`/v3/REST/campaign?Limit=${limit}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.post("/mcp/:secret", async (req, res) => {
  if (PATH_SECRET && req.params.secret !== PATH_SECRET) {
    res.status(404).end(); // 404, not 401 — don't confirm this path exists at all
    return;
  }
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: one transport per request
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: String(err) });
    }
  }
});

// Public, unauthenticated unsubscribe link — this is what the "unsubscribe
// here" link in every campaign email points to. Recipients click it straight
// from their inbox, so it deliberately does NOT require the /mcp path secret.
//
// The durable record is the Postgres row (source of truth). Best-effort, it
// also pushes the address into Snov.io's Do-Not-Contact list, and — since
// this server still holds Mailjet credentials too — flips
// IsExcludedFromCampaigns on the matching Mailjet contact, so the person
// stays suppressed no matter which platform a future send goes out from.
app.get("/unsub", async (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  const email = (req.query.email || "").toString().trim().toLowerCase();
  const context = (req.query.ctx || "").toString().slice(0, 200) || null;
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailPattern.test(email)) {
    res.status(400).send("<html><body><p>Missing or invalid email address.</p></body></html>");
    return;
  }
  // Each side-effect below is independently wrapped: a Postgres outage must
  // never prevent (or even delay) the Snov DNC sync attempt, since that sync
  // is the part that actually stops future sends. Every path logs a plain
  // stdout/stderr line so Render's own log retention is a usable fallback
  // record when the DB itself is unreachable.
  if (pgPool) {
    try {
      await pgPool.query(
        `INSERT INTO unsubscribes (email, source, campaign_context)
         VALUES ($1, 'link_click', $2)
         ON CONFLICT (email) DO NOTHING`,
        [email, context]
      );
    } catch (err) {
      console.error(`unsub_pg_insert_failed email=${email} error=${String(err).slice(0, 500)}`);
    }
  } else {
    console.error(`unsub_pg_insert_skipped email=${email} reason=pgPool_not_configured`);
  }

  const snovResult = await addToSnovDnc(email);

  if (pgPool) {
    try {
      await pgPool.query(
        `UPDATE unsubscribes
           SET snov_dnc_synced = $2,
               snov_dnc_detail = $3,
               last_sync_attempt_at = now()
         WHERE email = $1`,
        [email, !!snovResult.ok, JSON.stringify(snovResult).slice(0, 2000)]
      );
    } catch (err) {
      console.error(`unsub_pg_update_failed email=${email} error=${String(err).slice(0, 500)}`);
    }
  }

  // Best-effort, harmless even post-migration: keeps the old Mailjet
  // contact record in sync too, in case anything still reads it.
  if (MAILJET_API_KEY && MAILJET_API_SECRET) {
    unsubscribeEmail(email).catch((err) =>
      console.warn("Mailjet unsubscribe sync failed for", email, err)
    );
  }

  console.log(`unsub_processed email=${email} ctx=${context || ""} snov_ok=${!!snovResult.ok}`);

  try {
    res.send(`<!DOCTYPE html>
<html>
  <body style="font-family:Helvetica,Arial,sans-serif; max-width:480px; margin:64px auto; text-align:center; color:#111;">
    <h2 style="margin-bottom:8px;">You're unsubscribed</h2>
    <p style="color:#444;">${email} has been removed from future MindNote emails.</p>
  </body>
</html>`);
  } catch (err) {
    console.error("Unsubscribe failed for", email, err);
    res.status(500).send("<html><body><p>Something went wrong processing your request. Please try again later.</p></body></html>");
  }
});

// Read-only export for reconciliation. Protected by a shared-secret query
// token so this isn't a public data leak -- set EXPORT_TOKEN in Render env
// vars and pass it as ?token=... when pulling this from Claude.
app.get("/export", async (req, res) => {
  if (!pgPool) {
    res.status(503).json({ error: "database_not_configured" });
    return;
  }
  if (!EXPORT_TOKEN || req.query.token !== EXPORT_TOKEN) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const since = (req.query.since || "").toString();
  const params = [];
  let where = "";
  if (since) {
    params.push(since);
    where = "WHERE created_at > $1";
  }
  const result = await pgPool.query(
    `SELECT email, source, campaign_context, snov_dnc_synced, snov_dnc_detail, created_at
       FROM unsubscribes
       ${where}
      ORDER BY created_at ASC`,
    params
  );
  res.json({ count: result.rows.length, rows: result.rows });
});

app.get("/", (_req, res) => {
  res.send("Mailjet MCP HTTP server is running.");
});

const PORT = process.env.PORT || 3000;
ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Mailjet MCP server listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("failed_to_init_unsub_schema", err);
    // Don't block the whole server (MCP tools, Mailjet unsub) on the
    // unsubscribe-log schema failing to create — degrade gracefully.
    app.listen(PORT, () => {
      console.log(`Mailjet MCP server listening on port ${PORT} (unsub schema init failed)`);
    });
  });
