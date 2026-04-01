# Revision System

A personal revision tracker with spaced repetition, pause/unpause, revision history, search, export/import, dark mode, and Supabase realtime sync.

## Stack
- Next.js 15 + TypeScript
- Tailwind CSS
- Supabase Auth + Postgres + Realtime
- Client-side export/import

## Setup
1. Create a Supabase project.
2. Run the SQL in `supabase/schema.sql`.
3. Copy `.env.example` to `.env.local` and fill in your Supabase URL and anon key.
4. Install dependencies:
   ```bash
   npm install
   ```
5. Start the app:
   ```bash
   npm run dev
   ```

## Deployment
- Deploy to Vercel.
- Add the same env vars in the Vercel project settings.
- In Supabase, add your Vercel domain to the Auth redirect URLs.

## Notes
- All data is user-scoped and protected by Row Level Security.
- Deletes are soft deletes by default, so records can be restored.
- JSON export is full fidelity.
- CSV export is a flattened bundle that still contains all data in a single file.
