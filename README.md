# Our Day Sheet

A shared household chore chart plus a private day planner for each person.

- Site: GitHub Pages (this repo, `main` branch, root folder).
- Data: Supabase project `day-sheet`. Row-level security keeps each person's tasks, checkmarks, briefs and brain dumps private; chores are shared within the household.
- Claude writes the morning brief into the `briefs` table and sorts `brain_dumps` into tasks.
- To add someone to the household: insert their sign-in email into `household_members`.

The key in `app.js` is Supabase's publishable key, which is meant to be public. Access is enforced by the database's security rules.
