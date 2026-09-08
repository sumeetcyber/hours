# HOURS Online

This wraps the existing HOURS UI in a server-authoritative web app.

## Security model
- OTP is requested and verified by the server through Supabase Auth.
- Access/refresh tokens are stored in HttpOnly cookies; browser JS cannot read them.
- Every API request authenticates the cookie token server-side.
- User data is stored in Supabase Postgres, not localStorage.
- The server scopes state by the authenticated user id.
- Postgres RLS is enabled as defense-in-depth.
- Supabase service-role key exists only in the server environment.
- Realtime is relayed through the server; the browser never receives a service-role key.

## Run
1. Create a Supabase project.
2. Run `supabase/schema.sql` in the SQL editor.
3. Enable Email OTP in Supabase Auth and configure email delivery.
4. Copy `.env.example` to `.env` and fill the values.
5. `npm install`
6. `npm start`

The existing UI in `public/index.html` is intentionally retained as the design foundation.

### Important
A browser must hold transient UI state to render a web app. What is eliminated here is client-side persistence/authority: localStorage is not the source of truth, authentication is server-verified, and database writes are accepted only after server authentication.
