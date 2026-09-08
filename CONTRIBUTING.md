# Contributing

Use Node.js 22 or 24 and npm. Install with `npm ci`; commit `package-lock.json` whenever dependencies change. Do not commit `node_modules`, build output, or local environment files.

Read [the maintainer guide](docs/MAINTAINER_GUIDE.md) before changing semantics. Keep parsing, execution, presentation, grading, and code generation separate. Add focused regression cases for changed behavior and rewrite the affected documentation.

Before opening a pull request:

```bash
npm test
npm run build
```

For canvas changes, also run the [browser checks](docs/TESTING.md). Describe the original problem, resulting behavior, and validation in the pull request. GitHub Actions runs tests and builds on Windows and Linux with Node 22 and 24.

No application license has been selected in this project. Repository owners should choose one before distributing the project under open-source terms.

