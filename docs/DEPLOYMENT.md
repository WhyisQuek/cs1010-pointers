# Deploy PointerViz

PointerViz is a static, browser-only app. The C parser, interpreter, diagrams,
and challenges run on the visitor's device; no application server, database,
API key, or paid service is required for the current features.

## Student and instructor sites

The same source builds two sites:

| Site | Build | Output | Contents |
| --- | --- | --- | --- |
| Student | `npm run build` | `dist/` | Sandbox and Challenges |
| Instructor | `npm run build:instructor` | `dist-instructor/` | Sandbox, Challenges and the Level editor |

The student build does not contain the Level editor's code (CI checks this with
`npm run check:editions`). Neither build has logins: **serve the instructor site
behind the host's own access control** (for example NUS SSO, web-server password
protection or Cloudflare Access). Otherwise anyone who learns its address can
use it. Making the repository private hides the source, not the deployed sites.

Each build takes its own base path when hosted under a subdirectory, for example
`npm run build -- --base /pointerviz/` and
`npm run build:instructor -- --base /pointerviz-staff/`.

### Publishing levels to students

Levels saved in the Level editor live only in that instructor's browser. The
levels students see are the course pack, `public/levels/course.json`:

1. Open the instructor site (or run `npm run dev:instructor` locally).
2. To change levels already published, **Import pack** with the current
   `public/levels/course.json` first; imported levels replace their published
   versions in that browser's Challenges tab, so they can be tried as students
   will see them.
3. Create or edit levels, then **Export pack**.
4. Commit the exported file as `public/levels/course.json` and push. Both sites
   are rebuilt with it.

Students can read the course pack, including each level's reference C, by
fetching it directly. Hiding answers would need server-side grading.

## GitHub Pages

GitHub Free supports Pages from public repositories. A private repository
requires a plan that includes private-repository Pages. Publishing a site from
a private repository does not normally make the website private.

1. Confirm that the repository is eligible for Pages. Only make it public if
   you intend to share its source and Git history.
2. Open the repository's **Settings → Pages → Build and deployment** and choose
   **GitHub Actions** as the source.
3. Commit and push the deployment changes to `main`, including
   `src/App.jsx` and `.github/workflows/pages.yml`.
4. In **Actions**, open **Deploy to GitHub Pages**. It installs locked
   dependencies, runs the tests (including native C comparisons), builds both
   sites, checks the student build has no Level editor, and publishes only the
   student site (`dist/`). The instructor build is attached to the run as the
   `instructor-site` artifact (kept 30 days, visible to repository members)
   until it has its own access-controlled host. After the workflow exists on
   `main`, you can also use **Run workflow** to retry or redeploy.
5. Open the URL reported by the successful deployment. For the current remote,
   the expected address without a custom domain is
   <https://whyisquek.github.io/cs1010-pointers/>.

Later pushes to `main` repeat this process. Pull requests are checked by the
existing Validate workflow and do not publish the site. The deployment job
also rejects manual runs from other branches. No personal access token is
needed in repository secrets.

The workflow obtains the base path from GitHub Pages, so scripts, styles, and
both parser WASM files load below the correct repository path. The Tree-sitter
runtime (`tree-sitter.wasm`) is imported from the `web-tree-sitter` package, so
it always matches the installed JavaScript and is emitted once as a hashed
asset. The C grammar (`tree-sitter-c.wasm`) has no npm source here: keep it in
`public/`, and rebuild it with a compatible Tree-sitter ABI when upgrading
`web-tree-sitter`.

### Troubleshooting a blank page

If the live site is a white screen and the browser console shows a 404 for
`/src/main.jsx`, Pages is serving the raw repository instead of the built
`dist/` folder. In **Settings → Pages → Build and deployment**, set **Source**
to **GitHub Actions** (not "Deploy from a branch"), then re-run **Deploy to
GitHub Pages**. A "pages build and deployment" run in the Actions list is the
sign that branch publishing is still enabled.

## Test the production build locally

Requires Node.js 22 (22.12 or later) or 24 and installed dependencies (`npm ci`).

`npm run test:e2e` builds both sites with the Pages base path, serves them, and
runs the Playwright smoke tests against each automatically. To inspect the
student build by hand (use `build:instructor` and `--outDir dist-instructor`
for the instructor build):

```bash
npm test
npm run build -- --base /cs1010-pointers/
npm run preview -- --host 127.0.0.1 --port 4173 --base /cs1010-pointers/
```

Open <http://127.0.0.1:4173/cs1010-pointers/>. This tests the built files at the
same subpath as Pages, including the parser assets. Do not open `dist/index.html`
directly as a local file. Repeat these checks at the live HTTPS URL:

- Load and refresh the page; the parser must finish loading.
- Run the starter C program, step through it, and inspect its memory diagram.
- Open Challenges and load a level, including one from the course pack.
- Confirm the student site has no Level editor tab.
- On the instructor site, open Level editor and preview a sample program.
- Check for failed requests and runtime errors in the browser console.
- Test on another browser/device and follow the interaction checklist in
  [TESTING.md](TESTING.md).

## What testers should know

Challenge progress, and on the instructor site custom levels, are stored in
that browser's local storage. They are not shared between students, devices,
browser profiles or the two sites, and clearing browser data removes them.
Changing a site's domain creates a different storage origin; export custom
levels before moving and import them on the new site. There is no built-in
progress export or automatic migration. Distribute levels through the course
pack (see [Publishing levels to students](#publishing-levels-to-students)).

The app simulates the documented Mini-C subset; it does not execute arbitrary
native C. See [SUPPORTED_C.md](SUPPORTED_C.md) for the language limits.

## Move to another host or a custom domain

GitHub Pages already provides a live HTTPS website and can remain the host for
this static app. You can add a custom domain in Pages settings; rerun the
deployment after changing it so the build uses the new base path.

For another static host, use Node.js 24, install with `npm ci`, build with
`npm run build` and `npm run build:instructor`, and publish `dist` and
`dist-instructor` to their two locations, the second behind access control. The default base is `/` for
a domain root. If hosting under a subdirectory, pass its trailing-slash path,
for example `npm run build -- --base /pointerviz/`. Serve `.wasm` files with
the `application/wasm` MIME type. Navigation uses in-page tabs, so it does not
need server-side route rewrites. Preview is a local test server, not the
production hosting process.

Accounts, shared class data, and cross-device progress would require adding
a backend; moving the existing static files alone does not add those features.
Usage telemetry is the exception: it is optional, and its small collector runs
separately on Cloudflare (see [TELEMETRY.md](TELEMETRY.md)).

References: [GitHub Pages setup](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site),
[custom deployment workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages),
and [Vite static deployment](https://vite.dev/guide/static-deploy).
