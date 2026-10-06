/* Our Day Sheet — shared household chores + a private day planner per person.
   Data lives in Supabase; row-level security keeps each person's planner private. */
const SUPABASE_URL = "https://iekgcsexpoqututwhmbg.supabase.co";
const SUPABASE_KEY = "sb_publishable_tsb_djTLVmaUnM51xRIvMA_gWzN_DiT"; // publishable key, safe in the browser
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const CATS = {
  soft75: { name: "Soft 75", c: "var(--s75)" },
  chores: { name: "Household chores", c: "var(--home)" },
  home: { name: "Home & errands", c: "var(--home)" },
  inbox: { name: "Email & news", c: "var(--inbox)" },
  voice: { name: "Voice practice", c: "var(--voice)" },
  other: { name: "Other", c: "var(--other)" },
};
const ORDER = ["soft75", "chores", "inbox", "home", "voice", "other"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const fromIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const todayIso = () => iso(new Date());

let me = null;              // auth user
let member = false;         // on the household list
let householdId = null;
let people = [];            // profiles in the household
let tasks = [], checks = new Set(), brief = null, challenge = null;
let chores = [], choreChecks = {}, dumps = [];
let groceries = [], meals = {};
let viewDate = todayIso();

/* ---------- schedule logic ---------- */
function onWeek(t, d) { if (!t.anchor) return true; const w = Math.round((d - fromIso(t.anchor)) / 864e5 / 7); return ((w % 2) + 2) % 2 === 0; }
function repeatsOn(t, ds) {
  if (t.active === false) return false;
  const d = fromIso(ds), dow = d.getDay();
  if (t.start_date && ds < t.start_date) return false;
  if (t.repeat === "daily") return true;
  if (t.repeat === "weekdays") return dow > 0 && dow < 6;
  if (t.repeat === "weekly") return Number(t.dow) === dow;
  if (t.repeat === "biweekly") return Number(t.dow) === dow && onWeek(t, d);
  return null;
}
function appliesOn(t, ds) {
  const r = repeatsOn(t, ds); if (r !== null) return r;
  if (t.date === ds) return true;
  return !t.done_on && t.date < ds && ds === todayIso();
}
const isMine = (c) => !c.who || c.who === me.id;
function isDone(t) {
  if (t.kind === "chore") return !!choreChecks[t.id];
  return t.repeat === "once" ? !!t.done_on : checks.has(t.id);
}
function nameOf(id) {
  if (!id) return "Both";
  if (id === me.id) return "You";
  const p = people.find((x) => x.id === id);
  return (p && (p.display_name || p.email.split("@")[0])) || "Partner";
}
const repLabel = (t) => t.repeat === "weekly" ? "every " + DOW[t.dow] : t.repeat === "biweekly" ? "every other " + DOW[t.dow] : t.repeat;
function flash(id, msg, err) { $(id).textContent = msg; $(id).className = "status" + (err ? " err" : ""); }

/* ---------- render ---------- */
function todayItems() {
  const mine = tasks.filter((t) => appliesOn(t, viewDate));
  const ch = chores.filter((c) => isMine(c) && repeatsOn(c, viewDate)).map((c) => ({ ...c, kind: "chore", cat: "chores" }));
  return mine.concat(ch);
}
function render() {
  const d = fromIso(viewDate), today = todayIso();
  $("dateTitle").textContent = d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  const start = new Date(d.getFullYear(), 0, 0);
  const myName = (people.find((p) => p.id === me.id) || {}).display_name;
  $("dayNo").textContent = (myName ? myName + "'s day · " : "") + "Day " + Math.round((d - start) / 864e5) + " of " + d.getFullYear();
  $("todayBtn").setAttribute("aria-pressed", String(viewDate === today));
  const list = todayItems();
  const done = list.filter(isDone).length;
  $("countTxt").textContent = done + " of " + list.length + " done";
  $("barFill").style.width = (list.length ? (done / list.length) * 100 : 0) + "%";
  $("listNote").textContent = viewDate === today ? "" : viewDate < today ? "Past day" : "Coming up";
  const g = $("groups");
  if (!list.length) {
    g.innerHTML = '<p class="empty">Nothing on this day yet. Add a task in the Add tab.</p>';
  } else {
    g.innerHTML = ORDER.filter((c) => list.some((t) => (t.cat || "other") === c)).map((c) => {
      const items = list.filter((t) => (t.cat || "other") === c)
        .sort((a, b) => (isDone(a) - isDone(b)) || ((a.pri || 2) - (b.pri || 2)) || String(a.title).localeCompare(b.title));
      return `<div class="group" style="--c:${CATS[c].c}"><div class="group-head"><span class="chip"></span><span class="eyebrow">${CATS[c].name}</span></div>` +
        items.map((t) => {
          const dn = isDone(t), key = (t.kind === "chore" ? "ch_" : "t_") + t.id;
          const meta = [];
          if (t.pri == 1) meta.push('<span class="pri">must do</span>');
          if (t.kind === "chore") {
            meta.push(t.who ? "yours" : "shared");
            if (dn && choreChecks[t.id] !== me.id) meta.push("done by " + esc(nameOf(choreChecks[t.id])));
          } else if (t.repeat !== "once") meta.push(repLabel(t));
          if (t.repeat === "once" && t.date < viewDate && !dn) meta.push('<span class="late">from ' + fromIso(t.date).toLocaleDateString(undefined, { month: "short", day: "numeric" }) + "</span>");
          return `<div class="task${dn ? " done" : ""}"><input type="checkbox" class="check" id="${key}" data-id="${esc(t.id)}" data-kind="${t.kind || "task"}" ${dn ? "checked" : ""} aria-label="${esc(t.title)}"><label class="t-body" for="${key}"><span class="t-title">${esc(t.title)}</span>${meta.length ? `<span class="t-meta">${meta.map((m) => m.startsWith("<span") ? m : `<span>${m}</span>`).join("")}</span>` : ""}</label>` +
            (t.kind !== "chore" && t.repeat === "once" ? `<button class="x" data-del="${esc(t.id)}" aria-label="Delete ${esc(t.title)}">×</button>` : "<span></span>") + `</div>`;
        }).join("") + `</div>`;
    }).join("");
  }
  renderRoutines(); renderBrief(); renderChallenge(); renderChart(); renderDumps(); renderGroceries(); renderMenu();
}
function weekDays() { const v = fromIso(viewDate); return [1, 2, 3, 4, 5, 6, 0].map((d) => iso(weekDate(v, d))); }
const ingDraft = {};
const dayLabel = (ds) => { const d = fromIso(ds); return DOW[d.getDay()] + " " + d.getDate(); };
function keepFocus(fn) {
  const a = document.activeElement, id = a && a.id, pos = a && a.selectionStart;
  fn();
  if (id && $(id) && $(id) !== a) { const i = $(id); i.focus(); try { i.setSelectionRange(pos, pos); } catch (_) {} }
}
function renderMenu() {
  const el = $("menu"); if (!member) { el.innerHTML = ""; return; }
  const days = weekDays(), today = todayIso();
  $("menuWeek").textContent = "Week of " + fromIso(days[0]).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  keepFocus(() => {
    el.innerHTML = days.map((ds) => {
      const val = meals[ds] || "", ings = groceries.filter((g) => g.meal_day === ds);
      const showIng = val.trim() || ings.length;
      return `<div class="mday${ds === today ? " today" : ""}"><label class="dn" for="meal_${ds}">${dayLabel(ds).replace(" ", ' <span class="dd">')}</span></label>
        <div class="mbody"><input type="text" id="meal_${ds}" data-meal="${ds}" value="${esc(val)}" placeholder="${ds < today ? "" : "What's for dinner?"}" maxlength="200" autocomplete="off" aria-label="Dinner on ${dayLabel(ds)}">
        ${showIng ? `<div class="ings">${ings.map((g) => `<span class="ing${g.bought ? " got" : ""}">${g.bought ? "✓ " : ""}${esc(g.name)}</span>`).join("")}<form class="ingform" data-ingday="${ds}"><input type="text" id="ing_${ds}" value="${esc(ingDraft[ds] || "")}" placeholder="+ add ingredients" aria-label="Ingredients to buy for ${dayLabel(ds)}" autocomplete="off"></form></div>` : ""}</div></div>`;
    }).join("");
  });
}
function renderGrocFor() {
  const sel = $("grocFor"), cur = sel.value;
  const opts = weekDays().filter((ds) => (meals[ds] || "").trim() && ds >= todayIso());
  sel.innerHTML = '<option value="">Just the list</option>' + opts.map((ds) => `<option value="${ds}">${esc(dayLabel(ds))} · ${esc(meals[ds])}</option>`).join("");
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}
function renderGroceries() {
  const el = $("grocList");
  if (!member) { el.innerHTML = ""; return; }
  renderGrocFor();
  const need = groceries.filter((g) => !g.bought), got = groceries.filter((g) => g.bought);
  $("grocCount").textContent = need.length ? need.length + " to buy" : "";
  $("grocClearRow").hidden = !got.length;
  if (!groceries.length) { el.innerHTML = '<p class="empty">The list is empty. Add items here, or add ingredients to a dinner on the Dinner tab.</p>'; return; }
  const row = (g) => `<div class="task${g.bought ? " done" : ""}"><input type="checkbox" class="check" style="--c:var(--accent)" id="g_${esc(g.id)}" data-groc="${esc(g.id)}" ${g.bought ? "checked" : ""} aria-label="${esc(g.name)}"><label class="t-body" for="g_${esc(g.id)}"><span class="t-title">${esc(g.name)}</span>${g.added_by && g.added_by !== me.id ? `<span class="t-meta"><span>added by ${esc(nameOf(g.added_by))}</span></span>` : ""}</label><button class="x" data-delgroc="${esc(g.id)}" aria-label="Remove ${esc(g.name)}">×</button></div>`;
  const days = [...new Set(groceries.map((g) => g.meal_day).filter(Boolean))].sort();
  const groups = days.map((ds) => ({ title: `For ${dayLabel(ds)}${meals[ds] ? " · " + meals[ds] : ""}`, items: groceries.filter((g) => g.meal_day === ds) }));
  const other = groceries.filter((g) => !g.meal_day);
  if (other.length) groups.push({ title: days.length ? "Other items" : "", items: other });
  el.innerHTML = groups.map((gr) => {
    const items = gr.items.slice().sort((a, b) => a.bought - b.bought);
    return `<div class="ggroup">${gr.title ? `<div class="sub">${esc(gr.title)}</div>` : ""}${items.map(row).join("")}</div>`;
  }).join("");
}
function weekDate(v, d) { const m = new Date(v); m.setDate(v.getDate() - ((v.getDay() + 6) % 7)); const r = new Date(m); r.setDate(m.getDate() + ((d + 6) % 7)); return r; }
function renderChart() {
  const el = $("chart");
  const act = chores.filter((c) => c.active !== false);
  if (!act.length) { el.innerHTML = '<p class="empty">No household chores yet. Add the first one below.</p>'; return; }
  const vdate = fromIso(viewDate), vd = vdate.getDay();
  const daily = act.filter((c) => c.repeat === "daily");
  const rows = [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const items = act.filter((c) => /weekly$/.test(c.repeat) && Number(c.dow) === d && (c.repeat === "weekly" || onWeek(c, weekDate(vdate, d))));
    return `<div class="cday${d === vd ? " today" : ""}"><span class="dn">${DOW[d]}</span>${items.length ? `<ul>${items.map((c) => choreLi(c, d === vd)).join("")}</ul>` : '<span class="none">Free day</span>'}</div>`;
  }).join("");
  el.innerHTML = (daily.length ? `<div class="cday"><span class="dn">Daily</span><ul>${daily.map((c) => choreLi(c, true)).join("")}</ul></div>` : "") + rows;
}
function choreLi(c, isToday) {
  const dn = isToday && choreChecks[c.id];
  const cls = !c.who ? " both" : c.who === me.id ? " me" : "";
  return `<li class="cli"><span class="${dn ? "done" : ""}">${esc(c.title)}${c.repeat === "biweekly" ? ' <span class="t-meta">every other week</span>' : ""}</span><button class="who${cls}" data-who="${esc(c.id)}" aria-label="For ${esc(nameOf(c.who))}. Change">${esc(nameOf(c.who))}</button><button class="x" data-delchore="${esc(c.id)}" aria-label="Remove chore ${esc(c.title)}">×</button></li>`;
}
function renderChallenge() {
  const el = $("challenge");
  if (!challenge) { el.hidden = true; return; }
  const len = Number(challenge.length) || 75, n = Math.round((fromIso(viewDate) - fromIso(challenge.start)) / 864e5) + 1;
  el.hidden = false;
  const label = n < 1 ? `starts in ${1 - n} day${n === 0 ? "" : "s"}` : n > len ? "complete" : `Day ${n} of ${len}`;
  el.innerHTML = `<b>${esc(challenge.name)}</b><span>${label}</span><span class="cdots" aria-hidden="true">${Array.from({ length: len }, (_, i) => `<i class="${i + 1 < n ? "past" : i + 1 === n ? "now" : ""}"></i>`).join("")}</span>`;
}
function renderRoutines() {
  const r = tasks.filter((t) => t.repeat !== "once" && t.active !== false).sort((a, b) => ORDER.indexOf(a.cat) - ORDER.indexOf(b.cat));
  $("routines").innerHTML = r.length ? r.map((t) => `<div class="routine" style="--c:${(CATS[t.cat] || CATS.other).c}"><span class="chip"></span><span class="t-title">${esc(t.title)}</span><span class="t-meta">${repLabel(t)}</span><button class="x" data-del="${esc(t.id)}" aria-label="Remove routine ${esc(t.title)}">×</button></div>`).join("") : '<p class="empty">No routines yet. Add a task that repeats.</p>';
}
function renderBrief() {
  const b = brief;
  $("tab-brief").innerHTML = "Brief" + (b ? '<span class="dot" aria-label="new"></span>' : "");
  if (!b) { $("briefBody").innerHTML = '<p class="empty">' + (viewDate === todayIso() ? "No brief yet today. Your morning brief from Claude shows up here: where to focus, the day's chore, and a few headlines." : "No brief for this day.") + "</p>"; $("briefTime").textContent = ""; return; }
  let h = "";
  if (b.focus) h += `<p>${esc(b.focus)}</p>`;
  if (b.review) h += `<div class="sub">Week in review</div><p>${esc(b.review)}</p>`;
  if (Array.isArray(b.news) && b.news.length) h += `<div class="sub">Headlines</div><ul>` + b.news.map((n) => `<li>${/^https:\/\//.test(n.url || "") ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>` : esc(n.title)}${n.note ? ` — ${esc(n.note)}` : ""}</li>`).join("") + `</ul>`;
  $("briefBody").innerHTML = h || '<p class="empty">Brief is empty today.</p>';
  $("briefTime").textContent = b.updated_at ? new Date(b.updated_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
}
function renderDumps() {
  const open = dumps.filter((d) => !d.processed_at);
  $("dumpList").innerHTML = open.length ? `<div class="sub">Waiting for Claude</div>` + open.map((d) => `<div class="proposal"><span>${esc(d.body.length > 140 ? d.body.slice(0, 140) + "…" : d.body)}</span><button class="x" data-deldump="${esc(d.id)}" aria-label="Remove this note">×</button></div>`).join("") : "";
}
function renderWhoSelect() {
  const sel = $("chWho"), cur = sel.value;
  const opts = [["", "Both of us"], [me.id, "Me"]].concat(people.filter((p) => p.id !== me.id).map((p) => [p.id, p.display_name || p.email.split("@")[0]]));
  sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

/* ---------- data ---------- */
async function q(p) { const { data, error } = await p; if (error) throw error; return data; }
async function loadStatic() {
  const [prof, mem] = await Promise.all([
    q(sb.from("profiles").select("id,email,display_name,household_id")),
    q(sb.from("household_members").select("email,display_name,household_id")),
  ]);
  const mine = mem.find((m) => m.email.toLowerCase() === me.email.toLowerCase());
  member = !!mine; householdId = mine ? mine.household_id : null;
  people = prof.filter((p) => p.household_id && p.household_id === householdId);
  $("notMember").hidden = member;
  renderWhoSelect();
}
async function loadTasks() { tasks = await q(sb.from("tasks").select("*").order("created_at")); }
async function loadChores() { chores = member ? await q(sb.from("chores").select("*").order("created_at")) : []; }
async function loadGroceries() { groceries = member ? await q(sb.from("groceries").select("*").order("created_at")) : []; }
async function loadMeals() {
  if (!member) { meals = {}; return; }
  const days = [...new Set(weekDays().concat(groceries.map((g) => g.meal_day).filter(Boolean)))];
  const rows = await q(sb.from("meals").select("day,dinner").in("day", days));
  meals = {}; rows.forEach((r) => (meals[r.day] = r.dinner));
}
async function loadDumps() { dumps = await q(sb.from("brain_dumps").select("id,body,processed_at,created_at").is("processed_at", null).order("created_at")); }
async function loadChallenge() { const c = await q(sb.from("challenges").select("*").eq("key", "soft75")); challenge = c[0] || null; }
async function loadDay() {
  const day = viewDate;
  const [tc, cc, br] = await Promise.all([
    q(sb.from("task_checks").select("task_id").eq("day", day)),
    member ? q(sb.from("chore_checks").select("chore_id,done_by").eq("day", day)) : [],
    q(sb.from("briefs").select("*").eq("owner", me.id).eq("day", day)),
  ]);
  if (day !== viewDate) return;
  checks = new Set(tc.map((r) => r.task_id));
  choreChecks = {}; cc.forEach((r) => (choreChecks[r.chore_id] = r.done_by));
  brief = br[0] || null;
}
async function refreshAll() {
  try {
    await loadStatic();
    await Promise.all([loadTasks(), loadChores(), loadDumps(), loadChallenge(), loadDay(), loadGroceries().then(loadMeals)]);
    render();
  } catch (e) { console.error(e); $("groups").innerHTML = '<p class="empty">Couldn\'t load your day. Check your connection and reload.</p>'; }
}
async function goto(ds) { viewDate = ds; render(); try { await Promise.all([loadDay(), loadMeals()]); render(); } catch (e) { console.error(e); } }
$("prevDay").onclick = () => { const d = fromIso(viewDate); d.setDate(d.getDate() - 1); goto(iso(d)); };
$("nextDay").onclick = () => { const d = fromIso(viewDate); d.setDate(d.getDate() + 1); goto(iso(d)); };
$("todayBtn").onclick = () => goto(todayIso());

$("groups").addEventListener("change", async (e) => {
  const id = e.target.dataset.id; if (!id) return;
  const on = e.target.checked, kind = e.target.dataset.kind, day = viewDate;
  try {
    if (kind === "chore") {
      if (on) { choreChecks[id] = me.id; render(); await q(sb.from("chore_checks").upsert({ chore_id: id, day, household_id: householdId, done_by: me.id })); }
      else { delete choreChecks[id]; render(); await q(sb.from("chore_checks").delete().eq("chore_id", id).eq("day", day)); }
    } else {
      const t = tasks.find((x) => x.id === id);
      if (t.repeat === "once") { t.done_on = on ? day : null; render(); await q(sb.from("tasks").update({ done_on: t.done_on }).eq("id", id)); }
      else if (on) { checks.add(id); render(); await q(sb.from("task_checks").upsert({ task_id: id, day, owner: me.id })); }
      else { checks.delete(id); render(); await q(sb.from("task_checks").delete().eq("task_id", id).eq("day", day)); }
    }
  } catch (err) { console.error(err); flash("listStatus", "Couldn't save that check. Try again.", true); await refreshAll(); }
});
function armed(btn) { if (btn.dataset.armed === "1") return true; btn.dataset.armed = "1"; const old = btn.textContent; btn.textContent = "Delete?"; setTimeout(() => { btn.dataset.armed = ""; btn.textContent = old; }, 3000); return false; }
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  try {
    if (b.dataset.del) { if (!armed(b)) return; await q(sb.from("tasks").delete().eq("id", b.dataset.del)); await loadTasks(); render(); return; }
    if (b.dataset.delgroc) { groceries = groceries.filter((g) => g.id !== b.dataset.delgroc); renderGroceries(); renderMenu(); await q(sb.from("groceries").delete().eq("id", b.dataset.delgroc)); return; }
    if (b.id === "grocClear") { const ids = groceries.filter((g) => g.bought).map((g) => g.id); groceries = groceries.filter((g) => !g.bought); renderGroceries(); renderMenu(); if (ids.length) await q(sb.from("groceries").delete().in("id", ids)); return; }
    if (b.dataset.deldump) { await q(sb.from("brain_dumps").delete().eq("id", b.dataset.deldump)); await loadDumps(); render(); return; }
    if (b.dataset.delchore) { if (!armed(b)) return; await q(sb.from("chores").delete().eq("id", b.dataset.delchore)); await loadChores(); render(); return; }
    if (b.dataset.who) {
      const c = chores.find((x) => x.id === b.dataset.who); if (!c) return;
      const cycle = [null, me.id, ...people.filter((p) => p.id !== me.id).map((p) => p.id)];
      const next = cycle[(cycle.indexOf(c.who ?? null) + 1) % cycle.length];
      c.who = next; render();
      await q(sb.from("chores").update({ who: next }).eq("id", c.id));
    }
  } catch (err) { console.error(err); flash("chStatus", "Couldn't save that change. Try again.", true); await refreshAll(); }
});

$("newRepeat").onchange = () => { $("dowWrap").hidden = !/weekly$/.test($("newRepeat").value); };
$("chRepeat").onchange = () => { $("chDowWrap").hidden = $("chRepeat").value === "daily"; };
function schedule(body, dow) {
  if (body.repeat === "weekly" || body.repeat === "biweekly") body.dow = Number(dow);
  if (body.repeat === "biweekly") { const a = fromIso(viewDate); a.setDate(a.getDate() + ((body.dow - a.getDay() + 7) % 7)); body.anchor = iso(a); }
  return body;
}
$("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("newTitle").value.trim(); if (!title) return;
  $("addBtn").disabled = true;
  try {
    const body = schedule({ title: title.slice(0, 200), cat: $("newCat").value, repeat: $("newRepeat").value, pri: Number($("newPri").value), start_date: viewDate < todayIso() ? viewDate : todayIso() }, $("newDow").value);
    if (body.repeat === "once") body.date = viewDate;
    await q(sb.from("tasks").insert(body));
    $("newTitle").value = ""; flash("addStatus", "Added.");
    await loadTasks(); render();
  } catch (err) { console.error(err); flash("addStatus", "Couldn't add that task. Try again.", true); }
  $("addBtn").disabled = false;
});
$("choreForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("chTitle").value.trim(); if (!title || !member) return;
  $("chBtn").disabled = true;
  try {
    const body = schedule({ title: title.slice(0, 200), repeat: $("chRepeat").value, who: $("chWho").value || null, household_id: householdId, start_date: todayIso() }, $("chDow").value);
    await q(sb.from("chores").insert(body));
    $("chTitle").value = ""; flash("chStatus", "Chore added.");
    await loadChores(); render();
  } catch (err) { console.error(err); flash("chStatus", "Couldn't add that chore. Try again.", true); }
  $("chBtn").disabled = false;
});
$("grocList").addEventListener("change", async (e) => {
  const id = e.target.dataset.groc; if (!id) return;
  const g = groceries.find((x) => x.id === id); if (!g) return;
  g.bought = e.target.checked; renderGroceries(); renderMenu();
  try { await q(sb.from("groceries").update({ bought: g.bought, bought_at: g.bought ? new Date().toISOString() : null }).eq("id", id)); }
  catch (err) { console.error(err); flash("grocStatus", "Couldn't save that. Try again.", true); await loadGroceries(); renderGroceries(); }
});
$("grocForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const names = $("grocText").value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).map((x) => x.slice(0, 120));
  if (!names.length || !member) return;
  $("grocBtn").disabled = true;
  try { await q(sb.from("groceries").insert(names.map((name) => ({ name, household_id: householdId, meal_day: $("grocFor").value || null })))); $("grocText").value = ""; flash("grocStatus", ""); await loadGroceries(); renderGroceries(); renderMenu(); }
  catch (err) { console.error(err); flash("grocStatus", "Couldn't add those. Try again.", true); }
  $("grocBtn").disabled = false;
});
$("menu").addEventListener("submit", async (e) => {
  const f = e.target.closest(".ingform"); if (!f) return;
  e.preventDefault();
  const ds = f.dataset.ingday, inp = f.querySelector("input");
  const names = inp.value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).map((x) => x.slice(0, 120));
  if (!names.length) return;
  ingDraft[ds] = ""; inp.value = "";
  try { await q(sb.from("groceries").insert(names.map((name) => ({ name, household_id: householdId, meal_day: ds })))); await loadGroceries(); renderGroceries(); renderMenu(); flash("menuStatus", "Added to the grocery list."); }
  catch (err) { console.error(err); flash("menuStatus", "Couldn't add those. Try again.", true); }
});
const mealTimers = {};
$("menu").addEventListener("input", (e) => {
  if (e.target.id && e.target.id.startsWith("ing_")) { ingDraft[e.target.id.slice(4)] = e.target.value; return; }
  const ds = e.target.dataset.meal; if (!ds) return;
  meals[ds] = e.target.value;
  clearTimeout(mealTimers[ds]);
  mealTimers[ds] = setTimeout(async () => {
    try { await q(sb.from("meals").upsert({ household_id: householdId, day: ds, dinner: (meals[ds] || "").trim(), updated_at: new Date().toISOString() })); flash("menuStatus", "Saved."); renderMenu(); renderGrocFor(); }
    catch (err) { console.error(err); flash("menuStatus", "Couldn't save that dinner. Try again.", true); }
  }, 700);
});
$("dumpBtn").addEventListener("click", async () => {
  const body = $("dumpText").value.trim(); if (!body) return;
  $("dumpBtn").disabled = true;
  try { await q(sb.from("brain_dumps").insert({ body: body.slice(0, 4000) })); $("dumpText").value = ""; flash("dumpStatus", "Saved. Claude will sort it into tasks."); await loadDumps(); render(); }
  catch (err) { console.error(err); flash("dumpStatus", "Couldn't save that. Try again.", true); }
  $("dumpBtn").disabled = false;
});

/* ---------- tabs ---------- */
const TABS = ["today", "brief", "chores", "dinner", "groceries", "add", "routines"];
function showTab(name, focus) {
  if (!TABS.includes(name)) name = "today";
  document.querySelectorAll(".tabs [role=tab]").forEach((b) => { const on = b.dataset.tab === name; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
  document.querySelectorAll(".pane").forEach((p) => (p.hidden = p.dataset.pane !== name));
  try { localStorage.setItem("daysheet.tab", name); } catch (_) {}
}
document.querySelector(".tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) showTab(b.dataset.tab); });
document.querySelector(".tabs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const cur = TABS.indexOf(document.querySelector('.tabs [aria-selected="true"]').dataset.tab);
  showTab(TABS[(cur + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length], true); e.preventDefault();
});

/* ---------- live updates ---------- */
let channel = null;
function subscribeLive() {
  if (channel || !member) return;
  let timer = null, gTimer = null, mTimer = null;
  const soon = () => { clearTimeout(timer); timer = setTimeout(async () => { try { await Promise.all([loadChores(), loadDay()]); render(); } catch (_) {} }, 300); };
  channel = sb.channel("household")
    .on("postgres_changes", { event: "*", schema: "public", table: "chores" }, soon)
    .on("postgres_changes", { event: "*", schema: "public", table: "chore_checks" }, soon)
    .on("postgres_changes", { event: "*", schema: "public", table: "groceries" }, () => { clearTimeout(gTimer); gTimer = setTimeout(async () => { try { await loadGroceries(); await loadMeals(); renderGroceries(); renderMenu(); } catch (_) {} }, 300); })
    .on("postgres_changes", { event: "*", schema: "public", table: "meals" }, () => { clearTimeout(mTimer); mTimer = setTimeout(async () => { const a = document.activeElement; if (a && a.dataset && a.dataset.meal) return; try { await loadMeals(); renderMenu(); renderGroceries(); } catch (_) {} }, 300); })
    .subscribe();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && me) { if (viewDate < todayIso() && $("todayBtn").getAttribute("aria-pressed") === "true") viewDate = todayIso(); refreshAll(); }
});

/* ---------- auth ---------- */
let signingUp = false;
function setAuthMode(up) {
  signingUp = up;
  $("authTitle").textContent = up ? "Create your account" : "Sign in";
  $("authBtn").textContent = up ? "Create account" : "Sign in";
  $("authPass").autocomplete = up ? "new-password" : "current-password";
  $("authSwapLead").textContent = up ? "Already have an account?" : "First time here?";
  $("authSwap").textContent = up ? "Sign in" : "Create your account";
  flash("authStatus", up ? "Use the email Jeremiah added to the household, and pick a password of 8+ characters." : "");
}
$("authSwap").onclick = () => setAuthMode(!signingUp);
$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("authEmail").value.trim(), password = $("authPass").value;
  $("authBtn").disabled = true;
  try {
    if (signingUp) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      if (!data.session) {
        const r = await sb.auth.signInWithPassword({ email, password });
        if (r.error) { flash("authStatus", "Account created. Check your email to confirm it, then sign in."); setAuthMode(false); }
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    const m = String(err.message || "");
    flash("authStatus", /Invalid login/i.test(m) ? "That email and password don't match. Try again, or create your account first." : /registered/i.test(m) ? "That email already has an account. Sign in instead." : m || "Something went wrong. Try again.", true);
  }
  $("authBtn").disabled = false;
});
$("signOut").onclick = () => sb.auth.signOut();

async function enter(session) {
  me = session.user;
  $("authView").hidden = true; $("appView").hidden = false;
  $("whoami").textContent = me.email;
  let t = (location.hash || "").slice(1);
  if (!TABS.includes(t)) { try { t = localStorage.getItem("daysheet.tab"); } catch (_) { t = null; } }
  showTab(t || "today");
  await refreshAll();
  subscribeLive();
}
function leave() {
  me = null; if (channel) { sb.removeChannel(channel); channel = null; }
  $("appView").hidden = true; $("authView").hidden = false; setAuthMode(false);
}
sb.auth.onAuthStateChange((event, session) => {
  if (session && (!me || me.id !== session.user.id)) setTimeout(() => enter(session), 0);
  else if (!session && me) leave();
});
sb.auth.getSession().then(({ data }) => { if (data.session) { if (!me) enter(data.session); } else leave(); });
