# Deploy PointerViz

PointerViz is a static, browser-only app. The C parser, interpreter, diagrams,
and challenges run on the visitor's device; no application server, database,
API key, or paid service is required for the current features.

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
   dependencies, runs the tests (including native C comparisons), builds the
   app, and publishes only `dist/`. After the workflow exists on `main`, you
   can also use **Run workflow** to retry or redeploy.
5. Open the URL reported by the successful deployment. For the current remote,
   the expected address without a custom domain is
   <https://whyisquek.github.io/cs1010-pointers/>.

Later pushes to `main` repeat this process. Pull requests are checked by the
existing Validate workflow and do not publish the site. The deployment job
also rejects manual runs from other branches. No personal access token is
needed in repository secrets.

The workflow obtains the base path from GitHub Pages, so scripts, styles, and
both parser WASM files load below the correct repository path. Keep the two
`.wasm` files in `public/`; Vite copies them into the deployed output.

## Test the production build locally

Requires Node.js 22 or 24 and installed dependencies (`npm ci`).

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
- Open Challenges and load a level.
- Open Level editor and preview a sample program.
- Check for failed requests and runtime errors in the browser console.
- Test on another browser/device and follow the interaction checklist in
  [TESTING.md](TESTING.md).

## What testers should know

Custom levels and challenge progress are stored in that browser's local
storage. They are not shared between students, devices, or browser profiles,
and clearing browser data removes them. Changing the site's domain creates a
different storage origin; export custom levels before moving and import them
on the new site. There is no built-in progress export or automatic migration.
Use the level editor's JSON export/import to distribute custom levels.

The app simulates the documented Mini-C subset; it does not execute arbitrary
native C. See [SUPPORTED_C.md](SUPPORTED_C.md) for the language limits.

## Move to another host or a custom domain

GitHub Pages already provides a live HTTPS website and can remain the host for
this static app. You can add a custom domain in Pages settings; rerun the
deployment after changing it so the build uses the new base path.

For another static host, use Node.js 24, install with `npm ci`, build with
`npm run build`, and publish the `dist` directory. The default base is `/` for
a domain root. If hosting under a subdirectory, pass its trailing-slash path,
for example `npm run build -- --base /pointerviz/`. Serve `.wasm` files with
the `application/wasm` MIME type. Navigation uses in-page tabs, so it does not
need server-side route rewrites. Preview is a local test server, not the
production hosting process.

Accounts, shared class data, and cross-device progress would require adding
a backend; moving the existing static files alone does not add those features.

References: [GitHub Pages setup](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site),
[custom deployment workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages),
and [Vite static deployment](https://vite.dev/guide/static-deploy).
