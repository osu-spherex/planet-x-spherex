# frontend

Next.js (App Router) + TypeScript + vitest.

```
npm install      # once per worktree
npm run dev      # http://localhost:3000
npm test         # vitest, all *.test.ts(x)
npm run typecheck
npm run build
```

| Folder | Owner | What |
| --- | --- | --- |
| `app/`, `lib/`, `content/` | D | pages, coordinate parsing, explanations |
| `viewer/` | B | canvas viewer |
| `search/` | P | shift-and-stack and velocity grid search (no UI) |

Import across folders with the `@/` alias, e.g. `import { stack } from "@/search/stack"`.
Tests run in Node by default; a test that needs a DOM starts with `// @vitest-environment jsdom`.
This is Next.js 16: read `AGENTS.md` before writing page code.
