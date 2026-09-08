# HOURS

A personal time-logging app built around one idea:

> **Measure what you actually put into something.**

HOURS lets you log time against activities and categories, then see where your time is really going. It is deliberately not built around streaks, XP, daily quotas, or arbitrary productivity scores.

## What it does

- Log time against a pursuit, category, and sub-category.
- Add time manually or use the built-in timer.
- View history and edit or delete logged entries.
- Track progress toward long-term targets.
- See category/activity breakdowns and recent activity.
- Automatically roll activity data up through the category hierarchy.
- Use different visual themes, including font-aware themes.
- Export/import app data where supported by the UI.
- Sign in with email OTP.
- Sync data through a server and Supabase Postgres.
- Receive live state updates through a server-relayed realtime connection.

## Core idea

HOURS treats **logged time** as the basic unit instead of forcing everything into daily quotas.

For example:

```text
C++
├── Code
│   └── Practical 1       5h
└── Theory
    └── Unit 1 PDF       10h
```

The activity matrix can then calculate totals at higher levels without requiring the same time to be entered multiple times.

## Architecture

```text
Browser / Phone
      │
      │ HTTPS
      ▼
Node.js + Express server
      │
      ├── Supabase Auth (email OTP)
      │
      ├── Supabase Postgres
      │
      └── Supabase Realtime
```

The browser does **not** store the application's persistent state in `localStorage`. Authentication and database access go through the server.

The browser still necessarily has temporary UI state while the page is running; that is different from using the browser as the persistent source of truth.

## Security

- Email OTP is sent and verified through the server.
- Authentication is checked server-side on protected API routes.
- Session tokens are stored in `HttpOnly` cookies.
- User state is associated with the authenticated Supabase user ID.
- Postgres Row Level Security (RLS) is enabled on `user_state`.
- The Supabase server secret/service-role credential is never sent to the browser.
- Helmet security headers and API rate limiting are enabled.
- Realtime updates are relayed through the server.

## Project structure

```text
HOURS/
├── public/
│   └── index.html          # Web app UI
├── server/
│   └── index.mjs          # Express API, auth, sessions, realtime relay
├── supabase/
│   └── schema.sql         # Database table + RLS policies
├── package.json
├── README.md
└── .gitignore
```

## Local setup

### 1. Create Supabase project

Create a Supabase project and run:

```text
supabase/schema.sql
```

in the Supabase SQL Editor.

### 2. Configure email OTP

In Supabase Authentication, enable the Email provider and configure email delivery.

### 3. Configure environment variables

Create a local `.env` file from `.env.example` and provide:

```env
PORT=3000
SUPABASE_URL=your_supabase_project_url
SUPABASE_ANON_KEY=your_supabase_publishable_or_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_server_only_secret_key
```

**Do not commit this file.**

### 4. Install and run

```bash
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

## Deploying on Render

This repository is designed to run as a Node web service.

Use:

```text
Build Command: npm install
Start Command: npm start
```

Add the Supabase environment variables in Render's **Environment** settings. Do not upload `.env` to the repository.

The service must have access to:

```text
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

`PORT` is normally supplied by Render automatically.

## Database

The current schema uses a per-user `user_state` row containing the application's state as JSONB. RLS ensures database access is scoped to the authenticated user.

The schema is intentionally simple so the current app can be deployed without rebuilding the existing UI around a new data model.

## Current limitation

The current API is **server-backed**, but it is not yet a fully server-authoritative time ledger. The server authenticates the user before accepting state writes, while the current UI sends its state as JSON.

A future hardened version should move individual activities/logs into normalized database tables and expose dedicated server APIs for creating, editing, deleting, starting, and stopping timers. The server could then calculate timer durations and derived totals itself rather than trusting client-supplied duration values.

## Philosophy

HOURS is intentionally simple:

- No mandatory daily quota.
- No streak obsession.
- No XP pretending to measure skill.
- No arbitrary productivity score.
- Log the time you actually put into things you genuinely want to get better at.

**The point is not to look productive. The point is to know where your time went.**
