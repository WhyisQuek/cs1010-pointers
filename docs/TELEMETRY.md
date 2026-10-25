# Usage telemetry

PointerViz can record how students use it: the C they run, the diagrams they turn into C,
and their challenge answers. Events go to a small Cloudflare Worker (`telemetry/`) that
stores them in a D1 (SQLite) database. Both fit in Cloudflare's free tier for a course-sized
class.

Telemetry is **off** unless the build sets `VITE_TELEMETRY_URL`. `npm run dev`, the tests,
the Playwright build and forks without the setting send nothing.

## What is recorded

When telemetry is on, a notice in the corner of the page says what is recorded. Students
can turn it off with **Don't share**, and change their mind later with the **Usage data**
button in the top bar. Until they choose, events are sent (opt-out). Events have no name,
login or IP address, only:

| Field | Meaning |
| --- | --- |
| `client` | A random ID kept in the browser's local storage. Clearing site data, another browser or another device gives a new one. |
| `session` | A random ID for one page load. |
| `edition`, `version` | `student` or `instructor`, and the app version from `package.json`. |
| `client_at`, `received_at` | The browser's clock and the server's clock. |
| `type`, `data` | One of the events below; `data` is JSON. |

| Event | When | `data` |
| --- | --- | --- |
| `run` | **Run** in the sandbox | `code`; `steps` (`null` if the code did not compile); `error` (message, or `null`) |
| `generate` | **Generate C** in the sandbox | `state` (the memory shown, as MemoryState JSON); `step` (the playback step, or `null` for an edited diagram); `code` (the C generated, or `null`); `error` |
| `check` | **Check answer** in Challenges | `level`, `kind`, `attempt`, `pass`, `failure` (`crash`, `mismatch`, `level` or `null`), `diffs`; the answer as `code` (diagram → code) or `state` (code → diagram) |

Runs don't include their snapshots. The interpreter is deterministic, so running the same
`code` with the same `version` gives the same trace. An event over 60 KB drops `state`, then
`code`, and gets `"truncated": true`.

Students may put personal details in code comments. Tell them what is collected and how it
is used, keep the data only as long as you need it, and check whether your use needs ethics
approval. Research you intend to publish usually does. For opt-in instead of opt-out, make
`getChoice` in `src/data/telemetry.js` treat `null` as `'off'`.

## Set up

You need a free Cloudflare account and Node.js. Run these from the `telemetry/` folder.

1. Sign in to Cloudflare:

   ```bash
   npx wrangler login
   ```

2. Create the database:

   ```bash
   npx wrangler d1 create pointerviz-telemetry
   ```

   Copy the `database_id` it prints into `telemetry/wrangler.toml`, replacing
   `REPLACE_WITH_YOUR_DATABASE_ID`.

3. Create the table:

   ```bash
   npx wrangler d1 execute pointerviz-telemetry --remote --file schema.sql
   ```

4. Check `ALLOWED_ORIGINS` in `wrangler.toml`. It lists the sites allowed to send events,
   with scheme and host but no path. It has the GitHub Pages site,
   `https://whyisquek.github.io`, and `https://viz.cs1010.org`. Add any other site that
   serves PointerViz here.

5. Deploy the Worker:

   ```bash
   npx wrangler deploy
   ```

   It prints the Worker's address, such as
   `https://pointerviz-telemetry.<your-subdomain>.workers.dev`.

6. In the GitHub repository, open **Settings → Secrets and variables → Actions →
   Variables** and add a repository variable `TELEMETRY_URL` set to that address. It is a
   variable, not a secret: the address ends up in the public JavaScript anyway.

7. Push to `main` or run **Deploy to GitHub Pages** again. Only the student site is built
   with telemetry. To turn telemetry off, delete the variable and redeploy.

   A site hosted elsewhere, such as `https://viz.cs1010.org`, sends events only if its own
   build sets the variable too, for example
   `VITE_TELEMETRY_URL=https://pointerviz-telemetry.<your-subdomain>.workers.dev/ npm run build`.
   Its origin must also be in `ALLOWED_ORIGINS`.

8. Check it works: open the site, choose **OK**, press **Run**, then run:

   ```bash
   npx wrangler d1 execute pointerviz-telemetry --remote --command "SELECT id, received_at, type FROM events ORDER BY id DESC LIMIT 5"
   ```

Commit the `database_id` change to `wrangler.toml` so the next deploy uses the same
database. The ID is not a credential: only your Cloudflare account can use it.

### Try it locally first

```bash
npx wrangler d1 execute pointerviz-telemetry --local --file schema.sql
npx wrangler dev --var ALLOWED_ORIGINS:http://127.0.0.1:3000
```

Then, at the repository root, create `.env.local` (git ignores it) containing
`VITE_TELEMETRY_URL=http://127.0.0.1:8787/`, run `npm run dev`, and press **Run**. Query
with `--local` instead of `--remote` to see the events.

## Protection

The Worker accepts only `POST` requests from `ALLOWED_ORIGINS`, of at most 64 KB, shaped
like a PointerViz event. It also limits each browser ID to 120 events a minute. The limit
is per browser, not per IP, because a whole lab can share one campus address. Anyone can
read the collector's address in the site's JavaScript and send forged events, so treat the
data as indicative, not proof. For stronger protection, add a Cloudflare WAF rate-limiting
rule on the Worker's route.

## Read the data

Run queries with `npx wrangler d1 execute pointerviz-telemetry --remote --command "…"`, or
in the dashboard under **Storage & Databases → D1 → pointerviz-telemetry → Console**.

```sql
-- Runs per day, and how many distinct browsers ran code
SELECT date(received_at) AS day, count(*) AS runs, count(DISTINCT client) AS browsers
FROM events WHERE type = 'run' GROUP BY day ORDER BY day;

-- The commonest errors students hit
SELECT json_extract(data, '$.error') AS error, count(*) AS n
FROM events WHERE type = 'run' AND json_extract(data, '$.error') IS NOT NULL
GROUP BY error ORDER BY n DESC LIMIT 20;

-- Attempts per challenge, and how many browsers solved it
SELECT json_extract(data, '$.level') AS level, count(*) AS attempts,
       count(DISTINCT CASE WHEN json_extract(data, '$.pass') THEN client END) AS solved_by
FROM events WHERE type = 'check' GROUP BY level ORDER BY attempts DESC;
```

### Extract the code students wrote

Export the database, then turn it into `.c` files. Both commands run from the repository
root. Their output is student data, so git ignores both names; keep it out of the repository.

```bash
npx wrangler d1 export pointerviz-telemetry --remote --output telemetry-export.sql --config telemetry/wrangler.toml
node telemetry/export-code.mjs telemetry-export.sql telemetry-code
```

This writes one file per sandbox **Run** and per diagram → code **Check answer**, in
`telemetry-code/<browser ID>/`, numbered in the order they were sent. Each starts with a
comment giving the time, session, outcome and any error. `telemetry-code/index.csv` lists
them all. Its `source` column is `generate-c` for code run unchanged after **Generate C**,
which the student did not type. Events whose code was dropped for size are skipped. It
needs Node.js 22.13 or later.

To pull only the code into a spreadsheet instead, run:

```sql
SELECT id, received_at, client, type, json_extract(data, '$.code') AS code
FROM events WHERE type IN ('run', 'check') AND json_extract(data, '$.code') IS NOT NULL;
```

To save a copy, run
`npx wrangler d1 export pointerviz-telemetry --remote --output telemetry.sql`. To delete
old data, run `DELETE FROM events WHERE received_at < '2027-01-01';`.
