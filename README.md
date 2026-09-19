# kcd_sdk

The engine behind KCD, the Know / Care / Do framework — the file scanner, object model, and
dredge orchestrator. Starmind's documentation tools, the `sm_documentation` built-ins, run on it.

**You probably don't want to install this directly.** It is a library, not a tool, and it is
consumed from source by the projects beside it in the Starmind workspace.

## Working on it

Clone this **beside** the projects that import it, under this exact name, and install its
dependencies:

```
your-workspace/
├── kcd_sdk/        ← you are here
├── starmind/
└── starmind_dev/
```

```bash
npm install
```

There is no build step to run. The consumers alias `@kcd` and `@kcd/core` to this package's
`src/` in their own bundler and TypeScript config, so nothing in the workspace reads `dist/`.

## License

MIT. See [LICENSE](LICENSE).
