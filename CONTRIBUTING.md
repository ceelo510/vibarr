# Contributing to vibarr

Thank you for considering contributing! This document outlines the guidelines.

## Development Setup

1. Clone the repo
2. Copy `.env.example` to `.env` and fill in your API keys
3. Install dependencies:
   ```bash
   cd backend && npm install
   cd ../frontend && npm install
   ```
4. Start development:
   ```bash
   # Terminal 1: Backend
   cd backend && npm run dev

   # Terminal 2: Frontend
   cd frontend && npm run dev
   ```

## Code Structure

- **`backend/server.js`** — Express entry point. Route handling is being extracted to `backend/src/routes/`
- **`backend/src/`** — Shared modules: config, state, utils, middleware
- **`frontend/src/`** — React components and utilities

## Pull Request Guidelines

- Keep changes focused — one feature/fix per PR
- Add tests when possible (Vitest for frontend)
- Update `CHANGELOG.md` with your change (newest entry at top)
- Run `npm run build` in frontend before submitting to verify no build errors
- Ensure the frontend bundle can be verified with `grep` in the container

## Code Style

- ES modules (`import`/`export`) throughout
- React: functional components with hooks, no class components
- CSS: prefer Tailwind utility classes; use CSS custom properties for theming
- Inline styles only for dynamic values (e.g., gradients, progress bars)
- JSDoc on exported functions and complex components
- No TypeScript (yet) — keep it accessible

## Commit Messages

Follow conventional commits: `type: description`

- `feat:` — New feature
- `fix:` — Bug fix
- `refactor:` — Code restructuring
- `docs:` — Documentation
- `chore:` — Build/tooling changes

## Testing

```bash
cd frontend
npx vitest run     # Run tests
npx vitest         # Watch mode
```

Backend tests are not yet available — contributions welcome!

## Architecture Notes

- The backend proxies API calls to \*arr services using `X-Api-Key` headers (not query strings)
- All \*arr API keys are passed via environment variables, never baked into the Docker image
- Frontend polls the backend every 5 seconds for live updates
- The download pipeline tracks searches → grabs → imports in real-time
- Activity logs persist in memory and are flushed to disk on graceful shutdown
