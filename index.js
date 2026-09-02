import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

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
// It flips IsExcludedFromCampaigns on the matching Mailjet contact so the
// person is excluded from any future send this account makes.
app.get("/unsub", async (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  const email = (req.query.email || "").toString().trim().toLowerCase();
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailPattern.test(email)) {
    res.status(400).send("<html><body><p>Missing or invalid email address.</p></body></html>");
    return;
  }
  try {
    await unsubscribeEmail(email);
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

app.get("/", (_req, res) => {
  res.send("Mailjet MCP HTTP server is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mailjet MCP server listening on port ${PORT}`);
});
