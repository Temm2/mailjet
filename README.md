# Mailjet MCP HTTP server

A small remote MCP server that wraps the Mailjet API, so it can be added to
claude.ai / Cowork as a **custom connector**. Tested locally — the MCP
handshake and tool listing both work (`send_email`, `list_contacts`,
`get_contact`, `create_or_update_contact`, `list_campaigns`).

## 1. Put this code on GitHub (no `git` needed)

1. Go to https://github.com/new and create a new repository (public or
   private — either works with Render's free tier), e.g. `mailjet-mcp-http`.
2. On the new repo's page, click **"uploading an existing file"** and drag in
   every file from this folder *except* `node_modules` (there isn't one here
   — it wasn't included).
3. Commit the files.

## 2. Deploy it on Render.com (free tier)

1. Go to https://render.com and sign up (free).
2. Click **New +** → **Web Service**, connect your GitHub account, and pick
   the repo you just created.
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Under **Environment Variables**, add:
   - `MAILJET_API_KEY` — your Mailjet API key
   - `MAILJET_API_SECRET` — your Mailjet secret key
   - `MCP_PATH_SECRET` — a long random string. Generate one with
     `openssl rand -hex 24` in any terminal, or any password generator set to
     ~40+ characters. This is what keeps random internet strangers from
     calling your server — treat it like a password.
5. Click **Create Web Service** and wait for the build to finish (a couple
   of minutes). Render gives you a URL like
   `https://mailjet-mcp-http-xxxx.onrender.com`.

Note: Render's free tier spins the server down after periods of inactivity
and takes ~30-50 seconds to wake back up on the next request — the first
tool call after a quiet period may just time out or feel slow. That's normal
for a free instance, not a bug.

## 3. Add it to Claude as a custom connector

1. In claude.ai: **Customize → Connectors → Add custom connector**.
2. For the URL, use your Render URL *plus* `/mcp/` *plus* your
   `MCP_PATH_SECRET` value, e.g.:
   `https://mailjet-mcp-http-xxxx.onrender.com/mcp/a1b2c3...`
3. Leave the OAuth fields blank — this server doesn't use OAuth; the secret
   is already in the URL.
4. Click **Add**.

You should now see Mailjet's tools available to Claude in that chat.

## Tools this server exposes

- `send_email` — send one transactional email
- `list_contacts` / `get_contact` — read your contact list
- `create_or_update_contact` — create a contact and set custom properties
  (the same properties your campaign template's `[[data:...]]` tags read)
- `list_campaigns` — list campaigns on the account

This intentionally does *not* include a "send campaign to a whole list" tool
— sending to your full contact list is still best done deliberately through
Mailjet's own UI, where you can see exactly who it's going to before it
goes out.
