# kcd_sdk

The engine behind [Daedalus](https://github.com/bryancwinter/daedalus) — the file scanner,
object model, and dredge orchestrator for KCD, the Know / Care / Do framework.

**You probably don't want to install this directly.** It is a library, not a tool. Start at
the [Daedalus README](https://github.com/bryancwinter/daedalus#readme), which covers both
repositories.

## If you're building Daedalus

Clone this **beside** Daedalus, under this exact name, and install its dependencies before
building Daedalus — the bundler reads this package's source in place, so it resolves these
imports from here:

```
your-workspace/
├── kcd_sdk/     ← you are here
└── daedalus/
```

```bash
npm install
```

There is no build step to run. Nothing reads this package's `dist/`; Daedalus bundles from
`src/` directly.

## License

MIT. See [LICENSE](LICENSE).
