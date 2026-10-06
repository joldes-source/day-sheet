// Sends Day Sheet push notifications (morning rundown, dinner nudge, chore nudge, grocery heads-up).
// Called every 15 minutes by pg_cron ("tick"), by a database trigger when groceries are added ("grocery"),
// and by the app when someone taps "Send a test" ("test").
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const TZ = "America/Los_Angeles";
const SITE = "https://joldes-source.github.io/day-sheet/";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

type Row = Record<string, any>;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, apikey, x-client-info" } });

function laNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute), dow };
}
const fromIso = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
function onWeek(t: Row, day: string) { if (!t.anchor) return true; const w = Math.round((fromIso(day) - fromIso(t.anchor)) / 864e5 / 7); return ((w % 2) + 2) % 2 === 0; }
function applies(t: Row, day: string, dow: number) {
  if (t.active === false) return false;
  if (t.start_date && day < t.start_date) return false;
  switch (t.repeat) {
    case "daily": return true;
    case "weekdays": return dow > 0 && dow < 6;
    case "weekly": return Number(t.dow) === dow;
    case "biweekly": return Number(t.dow) === dow && onWeek(t, day);
    default: return t.date === day || (!t.done_on && t.date < day);
  }
}
const list = (xs: string[], n = 3) => xs.length <= n ? xs.join(", ") : xs.slice(0, n).join(", ") + ` and ${xs.length - n} more`;

let vapidReady = false;
async function initVapid() {
  if (vapidReady) return;
  const { data } = await db.from("app_secrets").select("key,value");
  const s = Object.fromEntries((data || []).map((r: Row) => [r.key, r.value]));
  webpush.setVapidDetails("mailto:joldes@me.com", s.vapid_public, s.vapid_private);
  vapidReady = true;
}
async function cronSecret() { const { data } = await db.from("app_secrets").select("value").eq("key", "cron_secret").single(); return data?.value; }

async function sendTo(owner: string, msg: { title: string; body: string; tag: string; url?: string }) {
  await initVapid();
  const { data: subs } = await db.from("push_subscriptions").select("*").eq("owner", owner);
  let sent = 0;
  for (const s of subs || []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ ...msg, url: msg.url || SITE }), { TTL: 3600 });
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) await db.from("push_subscriptions").delete().eq("id", s.id);
      else console.error("push failed", e?.statusCode, e?.body);
    }
  }
  return sent;
}
async function once(owner: string, kind: string, day: string) {
  const { data, error } = await db.from("notify_log").insert({ owner, kind, day }).select();
  return !error && data && data.length > 0;
}

async function tick() {
  const now = laNow();
  const kinds: string[] = [];
  if (now.hour === 7) kinds.push("morning");
  if (now.hour === 15) kinds.push("dinner");
  if (now.hour === 18) kinds.push("chores");
  if (!kinds.length) return { now, sent: 0 };

  const { data: subs } = await db.from("push_subscriptions").select("owner");
  const owners = [...new Set((subs || []).map((s: Row) => s.owner))];
  if (!owners.length) return { now, sent: 0 };
  const [{ data: prefs }, { data: profiles }] = await Promise.all([
    db.from("notify_prefs").select("*").in("owner", owners),
    db.from("profiles").select("id,display_name,household_id").in("id", owners),
  ]);
  let sent = 0;
  for (const owner of owners) {
    const p = (prefs || []).find((x: Row) => x.owner === owner) || { morning: true, chores: true, dinner: true };
    const prof = (profiles || []).find((x: Row) => x.id === owner);
    if (!prof?.household_id) continue;
    const hh = prof.household_id;
    const [{ data: chores }, { data: checks }, { data: meal }, { data: tasks }, { data: tchecks }] = await Promise.all([
      db.from("chores").select("*").eq("household_id", hh),
      db.from("chore_checks").select("chore_id").eq("household_id", hh).eq("day", now.day),
      db.from("meals").select("dinner").eq("household_id", hh).eq("day", now.day),
      db.from("tasks").select("*").eq("owner", owner),
      db.from("task_checks").select("task_id").eq("owner", owner).eq("day", now.day),
    ]);
    const myChores = (chores || []).filter((c: Row) => (!c.who || c.who === owner) && applies(c, now.day, now.dow));
    const doneChores = new Set((checks || []).map((r: Row) => r.chore_id));
    const dinner = (meal?.[0]?.dinner || "").trim();
    const doneTasks = new Set((tchecks || []).map((r: Row) => r.task_id));
    const mustDo = (tasks || []).filter((t: Row) => t.pri === 1 && applies(t, now.day, now.dow) && !(t.repeat === "once" ? t.done_on : doneTasks.has(t.id)));

    if (kinds.includes("morning") && p.morning && await once(owner, "morning", now.day)) {
      const bits: string[] = [];
      if (myChores.length) bits.push("Chores: " + list(myChores.map((c: Row) => c.title.split(":")[0])));
      if (mustDo.length) bits.push(`${mustDo.length} must-do${mustDo.length > 1 ? "s" : ""}: ` + list(mustDo.map((t: Row) => t.title), 2));
      bits.push(dinner ? "Dinner: " + dinner : "No dinner planned yet");
      sent += await sendTo(owner, { title: `Good morning${prof.display_name ? ", " + prof.display_name : ""}`, body: bits.join(" · "), tag: "morning" });
    }
    if (kinds.includes("dinner") && p.dinner && !dinner && await once(owner, "dinner", now.day)) {
      sent += await sendTo(owner, { title: "What's for dinner?", body: "Nothing's planned for tonight yet. Tap to add it to the menu.", tag: "dinner", url: SITE + "#dinner" });
    }
    if (kinds.includes("chores") && p.chores) {
      const left = myChores.filter((c: Row) => !doneChores.has(c.id));
      if (left.length && await once(owner, "chores", now.day)) {
        sent += await sendTo(owner, { title: left.length === 1 ? "One chore left today" : `${left.length} chores left today`, body: list(left.map((c: Row) => c.title)), tag: "chores", url: SITE + "#chores" });
      }
    }
  }
  return { now, sent };
}

async function grocery(body: Row) {
  const { household_id, added_by, names } = body;
  if (!household_id || !Array.isArray(names) || !names.length) return { sent: 0 };
  const { data: people } = await db.from("profiles").select("id,display_name").eq("household_id", household_id);
  const who = (people || []).find((x: Row) => x.id === added_by)?.display_name || "Someone";
  let sent = 0;
  for (const person of people || []) {
    if (person.id === added_by) continue;
    const { data: pr } = await db.from("notify_prefs").select("groceries").eq("owner", person.id);
    if (pr?.[0] && pr[0].groceries === false) continue;
    sent += await sendTo(person.id, { title: "Grocery list", body: `${who} added ${list(names, 4)}`, tag: "groceries", url: SITE + "#groceries" });
  }
  return { sent };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({});
  let body: Row = {};
  try { body = await req.json(); } catch (_) {}
  try {
    if (body.mode === "test") {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data } = await db.auth.getUser(token);
      if (!data?.user) return json({ error: "sign in first" }, 401);
      const sent = await sendTo(data.user.id, { title: "Notifications are on", body: "This is how Day Sheet reminders will look.", tag: "test" });
      return json({ sent });
    }
    if (body.secret !== await cronSecret()) return json({ error: "forbidden" }, 403);
    if (body.mode === "tick") return json(await tick());
    if (body.mode === "grocery") return json(await grocery(body));
    return json({ error: "unknown mode" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "failed" }, 500);
  }
});
