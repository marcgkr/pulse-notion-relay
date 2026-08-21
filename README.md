# PULSE Brand Playbook → Notion relay

Receives each Brand Playbook submission and creates one Notion page per client,
with every question and answer written into the page body so the team can read
it top to bottom and pull the story angle out.

Deploy to Railway. Two files, one dependency, no database of its own.

---

## 1. Build the Notion database

Create a new database in Notion (full page, not inline). Call it
**Brand Playbook Submissions**. Add these properties, names spelled exactly:

| Property name  | Type          | Notes |
|----------------|---------------|-------|
| Name           | Title         | The client's name, already there by default |
| Client         | Text          | The `?client=` slug from the link |
| Status         | **Select**    | Add options: New submission, Reviewed, Story drafted, Done |
| Submitted      | Date          | |
| Form           | Text          | Form name and version |
| Age            | Text          | |
| Kids           | Text          | |
| Pets           | Text          | |
| Archetype      | Text          | |
| Marital status | Text          | |
| Off limits     | Text          | What the client will not talk about |
| Voice          | Multi-select  | Leave the options empty, Notion fills them in |
| Has private    | Checkbox      | True if any answer was marked private |
| Page URL       | URL           | |

Status must be a **Select**, not Notion's built-in Status type. The API cannot
write to Status columns.

Any property you skip is simply ignored, the relay reads the schema on boot and
only writes columns that exist. Rename one and it drops out quietly, so keep the
names as above.

Grab the database ID from the URL. It is the 32-character string between the
last `/` and the `?`:

```
https://www.notion.so/pulse/1f4a9c8e2b3d40a7b9c1d2e3f4a5b6c7?v=...
                            └────────── this bit ──────────┘
```

## 2. Create the Notion integration

1. Go to notion.so/my-integrations → New integration.
2. Name it "PULSE Playbook Relay", pick the PULSE workspace, capability
   "Insert content" and "Read content".
3. Copy the Internal Integration Secret, it starts with `ntn_`.
4. Open the database page → `...` menu → Connections → add the integration.
   Skip this step and every submission fails with "object not found".

## 3. Deploy to Railway

New Project → Deploy from GitHub repo (push these two files), or `railway up`
from this folder. Then Variables:

```
NOTION_TOKEN=ntn_xxxxxxxxxxxxxxxxxxxx
NOTION_DATABASE_ID=1f4a9c8e2b3d40a7b9c1d2e3f4a5b6c7
ALLOWED_ORIGINS=https://playbook.pulsedigital.sg,https://pulsedigital.sg
```

`ALLOWED_ORIGINS` is a comma-separated list of the domains the form is served
from. Leave it unset only for local testing.

Railway sets `PORT` itself, do not add it. Settings → Networking → Generate
Domain to get the public URL, something like
`https://pulse-notion-relay-production.up.railway.app`.

Check it is alive: open `/health`, it should return `{"ok":true,"schemaLoaded":true}`.
If `schemaLoaded` is false the token, database ID, or the integration connection
is wrong.

## 4. Point the form at it

In `pulse-brand-playbook.html`, line 550:

```js
const RESPONSES_ENDPOINT = "";
```

becomes

```js
const RESPONSES_ENDPOINT = "https://pulse-notion-relay-production.up.railway.app/submit";
```

That is the only change to the HTML. It already builds the full payload, sends
it on the finish screen, and never sends twice.

## 5. Test

Open the form with a client slug, `?client=fusion-medical`, run through it and
submit. A page appears in the database within a couple of seconds. The form
shows "Saved. Your answers are with the PULSE team." on success and an error
line on failure, so a silent failure is not possible.

If nothing lands, Railway → Deployments → Logs will show either a CORS-blocked
request or the exact Notion error message.

---

## What the Notion page looks like

Properties carry the sortable fields, so the team can filter by Client, Status,
or Has private. The page body carries the interview itself:

- A callout at the top with the submission time, and a lock icon plus a warning
  line if any answer was marked private.
- One heading per section, following the same 11-section narrative arc as the
  form: the basics, warm-up, who you were, what you struggled with, the lowest
  point, what changed, who you became, why you do this, what you believe, the
  human stuff, your lines.
- Each question in bold with the answer underneath. Private answers are set in
  red italics so nobody lifts one into a caption by accident.
- Unanswered optional questions are left out rather than showing blank rows.

Long answers get split across multiple text runs because Notion caps a single
run at 2000 characters, and pages with more than 100 blocks are appended in
batches. Neither is visible in the finished page.

## Notes on abuse

The relay rate-limits to 5 submissions per IP per 10 minutes and rejects
requests from origins not on the allowlist. That is enough for a link sent
privately to clients. If the form ever goes fully public and starts collecting
junk, the next step is a Cloudflare Turnstile widget on the final screen with
server-side verification before the Notion call, roughly 20 lines.

## Optional: ping the team on submission

If you want a nudge in Slack or an email rather than checking Notion, add a
second fetch in the `/submit` handler after the page is created. A Slack
incoming webhook is the shortest path, one POST with the client name and the
`page.url` the relay already returns.
