// Clinic mode (optional). Leave both values empty to run PhysioNotes on its own (this device, optionally synced
// through your own Dropbox). To enable clinic sign-in, shared approval and the admin directory, create a free
// Supabase project, run supabase/schema.sql in it, and fill in its Project URL and "anon public" key here
// (or build with:  npm run build -- --url https://xxxx.supabase.co --key <anon key> --name "My Clinic").
// The anon key is designed to be public: the database only exposes checked functions and encrypts patient data
// in the browser, so it grants nothing by itself.
// offlineDays: how long the app may be opened offline between successful clinic check-ins (default 7).
export const CLINIC = { supabaseUrl: '', anonKey: '', clinicName: '', offlineDays: 7 };
