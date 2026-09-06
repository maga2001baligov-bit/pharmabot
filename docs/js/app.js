import { Storage } from "./storage.js?v=12";
import { compareRecipe } from "./recipeMatch.js?v=12";

window.addEventListener("error", (e) => {
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:#dc2626;color:#fff;padding:14px;font-size:13px;white-space:pre-wrap;font-family:monospace;";
  box.textContent = "JS ERROR: " + e.message + "\n" + (e.filename || "") + ":" + (e.lineno || "");
  document.body.prepend(box);
});

const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const toggle = document.getElementById("theme-toggle");
  if (toggle) toggle.setAttribute("aria-checked", theme === "dark" ? "true" : "false");
}

function initTheme() {
  let theme = Storage.getTheme();
  if (!theme) {
    // first visit: match Telegram's current color scheme if available, else light
    theme = (tg && tg.colorScheme === "dark") ? "dark" : "light";
    Storage.setTheme(theme);
  }
  applyTheme(theme);
}
initTheme();

const themeToggleBtn = document.getElementById("theme-toggle");
if (themeToggleBtn) {
  themeToggleBtn.addEventListener("click", () => {
    const next = Storage.getTheme() === "dark" ? "light" : "dark";
    Storage.setTheme(next);
    applyTheme(next);
  });
}

// Live-sync with Telegram's theme if the user switches it while the app is open,
// but only if they haven't manually overridden the toggle themselves this session.
let userOverrodeTheme = false;
if (themeToggleBtn) themeToggleBtn.addEventListener("click", () => { userOverrodeTheme = true; });
if (tg && typeof tg.onEvent === "function") {
  tg.onEvent("themeChanged", () => {
    if (userOverrodeTheme) return;
    const next = tg.colorScheme === "dark" ? "dark" : "light";
    Storage.setTheme(next);
    applyTheme(next);
  });
}

function applyFontSize(size) {
  document.body.classList.remove("fs-small", "fs-medium", "fs-large");
  document.body.classList.add(`fs-${size}`);
  const seg = document.getElementById("setting-fontsize");
  if (seg) {
    [...seg.children].forEach((b) => b.classList.toggle("active", b.dataset.size === size));
  }
}

const OPTION_LABELS = ["А", "Б", "В", "Г", "Д", "Е", "Ж", "З"];
const KIND_LABEL = {
  matching: "Соответствие",
  fill_blank: "Вставьте слова",
  table: "Классификация",
  characterize: "Охарактеризуйте",
  flashcard: "Вопрос",
};
const EXAM_SIZE = { test: 40, recipe: 20 };

let ALL_TESTS = [];
let ALL_RECIPES = [];
let ALL_THEORY = { q1: [], q2: [], q3: [] };
let theoryBook = { list: [], index: 0 };
let session = null;

const screens = {};
["home", "modes", "topics", "search", "errors", "session", "result", "stats", "settings", "sessions", "achievements", "unlock", "theory-hub", "theory-list"].forEach((n) => {
  screens[n] = document.getElementById(`screen-${n}`);
});

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderFlashcardBody(raw, revealed) {
  const boldRe = /\*\*(.+?)\*\*/g;
  let out = "", last = 0, m;
  while ((m = boldRe.exec(raw)) !== null) {
    out += escapeHtml(raw.slice(last, m.index));
    out += revealed ? `<b>${escapeHtml(m[1])}</b>` : `<span class="blank">···</span>`;
    last = boldRe.lastIndex;
  }
  out += escapeHtml(raw.slice(last));
  return out;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function sample(arr, n) { return shuffle(arr).slice(0, Math.min(n, arr.length)); }

async function loadData() {
  const [t, r, th] = await Promise.all([fetch("data/tests.json"), fetch("data/recipes.json"), fetch("data/theory.json")]);
  ALL_TESTS = await t.json();
  ALL_RECIPES = await r.json();
  ALL_THEORY = await th.json();
}

function allIds(kind) { return (kind === "test" ? ALL_TESTS : ALL_RECIPES).map((x) => x.id); }
function byId(kind, id) { return (kind === "test" ? ALL_TESTS : ALL_RECIPES).find((x) => x.id === id); }

// ---------------------------------------------------------------------
// HOME
// ---------------------------------------------------------------------

function renderHome() {
  const today = Storage.getTodayCounts();
  const doneToday = today.correct + today.wrong;
  renderGoalRing(doneToday);
  document.getElementById("today-strip").innerHTML = `
    <div class="stat-chip ok"><div class="n">${today.correct}</div><div class="l">верно сегодня</div></div>
    <div class="stat-chip no"><div class="n">${today.wrong}</div><div class="l">ошибок сегодня</div></div>
  `;

  const st = Storage.getStats(ALL_TESTS.length, ALL_RECIPES.length);
  document.getElementById("progress-strip").innerHTML = `
    <div class="stat-chip"><div class="n">${st.tests.seen}/${st.tests.total}</div><div class="l">тестов изучено</div></div>
    <div class="stat-chip"><div class="n">${st.recipes.seen}/${st.recipes.total}</div><div class="l">рецептов изучено</div></div>
  `;

  document.getElementById("card-tests-sub").textContent = `${ALL_TESTS.length} заданий · точность ${st.tests.pct}%`;
  document.getElementById("card-recipes-sub").textContent = `${ALL_RECIPES.length} препаратов · точность ${st.recipes.pct}%`;

  const errT = Storage.getErrorIds("test").length;
  const errR = Storage.getErrorIds("recipe").length;
  document.getElementById("card-errors-sub").textContent =
    errT + errR > 0 ? `Тесты: ${errT} · Рецепты: ${errR}` : "Пока нет ошибок";

  const gamiOn = Storage.getSettings().gamification !== false;
  document.getElementById("gami-strip").classList.toggle("hidden", !gamiOn);
  document.getElementById("gami-week").classList.toggle("hidden", !gamiOn);
  document.getElementById("card-achievements").classList.toggle("hidden", !gamiOn);
  if (gamiOn) {
    renderGamiStrip();
    const defsForSub = computeAchievements();
    document.getElementById("card-ach-sub").textContent = `${defsForSub.filter((d) => d.done).length} из ${defsForSub.length}`;
  }

  renderContinueCard();
  if (gamiOn && checkAndShowNewAchievements()) return;
  showScreen("home");
}

/**
 * "Видимая цель на сегодня" — a small, achievable number (default 10) shown
 * as a ring right on Home, so progress is visible without opening anything.
 * Deliberately independent from the bigger "Заниматься" queue size — the
 * point is for the daily bar to feel almost-already-cleared, not looming.
 */
function renderGoalRing(doneToday) {
  const goal = Math.max(1, Storage.getSettings().dailyGoal || 10);
  const pct = Math.min(1, doneToday / goal);
  const r = 27, c = 2 * Math.PI * r;
  const fill = document.getElementById("goal-ring-fill");
  fill.setAttribute("stroke-dasharray", `${(pct * c).toFixed(1)} ${c.toFixed(1)}`);
  fill.style.stroke = pct >= 1 ? "var(--green)" : "var(--blue)";
  const title = document.getElementById("goal-ring-title");
  const sub = document.getElementById("goal-ring-sub");
  if (doneToday >= goal) {
    title.textContent = `Сегодня: ${doneToday} / ${goal} 🎉`;
    sub.textContent = "Цель на день выполнена!";
  } else {
    title.textContent = `Сегодня: ${doneToday} / ${goal}`;
    sub.textContent = "Цель на день · тапни, чтобы изменить";
  }
}

/**
 * Recipe pairs/groups that students commonly mix up on the exam — similar
 * name, similar drug class, or opposite mechanism. Used by the "🔀 Путающиеся
 * препараты" mode to build interleaved practice queues (A,B,A,B… instead of
 * blocked A,A,B,B…), which is the actual evidence-backed way to learn to
 * tell confusable things apart.
 */
const CONFUSABLE_GROUPS = [
  { ids: [29, 96], why: "Сердечные гликозиды разной скорости и длительности действия" },
  { ids: [25, 27, 85], why: "Глюкокортикоиды короткого / среднего / длительного действия" },
  { ids: [14, 86], why: "М-холиноблокатор vs антихолинэстеразное — противоположный эффект" },
  { ids: [59, 122, 62], why: "иАПФ (два) vs БРА — разный механизм снижения давления" },
  { ids: [110, 33, 40], why: "Петлевой vs тиазидные/тиазидоподобные диуретики" },
  { ids: [12, 68, 16, 132], why: "Неселективный vs β1-селективные адреноблокаторы" },
  { ids: [71, 87, 105], why: "Наркотические анальгетики разной силы и скорости действия" },
  { ids: [30, 41, 135], why: "НПВС — разная сила и переносимость" },
  { ids: [37, 92], why: "Основные противотуберкулёзные первой линии" },
  { ids: [75, 139, 142], why: "Блокаторы Ca-каналов: дигидропиридиновые vs недигидропиридиновые" },
  { ids: [58, 76], why: "Местные анестетики: амидный vs эфирный" },
  { ids: [65, 82], why: "Антигельминтные с разным механизмом действия" },
  { ids: [24, 128], why: "Антикоагулянты: парентеральный немедленный vs пероральный" },
  { ids: [119, 78], why: "Н2-блокатор vs ИПП — оба «от язвы», механизм разный" },
  { ids: [7, 95, 111], why: "Антиаритмики разных классов" },
  { ids: [19, 26], why: "Похожие названия сахароснижающих сульфонилмочевины" },
  { ids: [84, 91, 101], why: "Витамины группы B — путаются номера/названия" },
  { ids: [9, 10], why: "Похожие пенициллины — с клавулановой кислотой и без" },
];

/** Interleave one or more groups of ids: A,B,C,A,B,C,… (reps rounds) instead of blocked A,A,B,B. */
function interleaveGroups(groups, reps) {
  const queue = [];
  for (let r = 0; r < reps; r++) {
    groups.forEach((g) => queue.push(...g));
  }
  return queue;
}

const MODE_LABELS = {
  today: "Заниматься", all: "Все по порядку", exam: "Экзамен", random: "Случайные",
  errors: "Ошибки", favorites: "Избранное", review: "Повторение", learn: "Просмотр", single: "Из поиска",
  topic: "По группе", confusables: "Путающиеся препараты", sprint: "Спринт 5 минут",
};

function renderContinueCard() {
  const card = document.getElementById("continue-card");
  const moreBtn = document.getElementById("btn-all-sessions");
  const latest = Storage.getLatestSession();
  const all = Storage.getSessions();
  if (!latest) {
    card.classList.add("hidden");
    moreBtn.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  document.getElementById("continue-counter").textContent = `${latest.pos + 1} / ${latest.queue.length}`;
  const pct = Math.round((100 * latest.pos) / latest.queue.length);
  document.getElementById("continue-bar-fill").style.width = `${pct}%`;
  document.getElementById("continue-title").textContent =
    `▶ Продолжить: ${latest.kind === "test" ? "тесты" : "рецепты"} · ${MODE_LABELS[latest.mode] || latest.mode}`;
  card.onclick = () => resumeSession(latest);

  if (all.length > 1) {
    moreBtn.classList.remove("hidden");
    moreBtn.textContent = `Все сессии (${all.length})`;
  } else {
    moreBtn.classList.add("hidden");
  }
}

function renderSessionsList() {
  const all = Storage.getSessions();
  const list = document.getElementById("sessions-list");
  if (!all.length) {
    list.innerHTML = `<div class="search-empty">Пока нет сохранённых сессий</div>`;
  } else {
    list.innerHTML = all.map((s) => {
      const pct = Math.round((100 * s.pos) / s.queue.length);
      const date = new Date(s.updatedAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      return `
        <button class="mode-btn session-hit" data-sid="${s.id}">
          <span>
            <span class="t">${s.kind === "test" ? "Тесты" : "Рецепты"} · ${escapeHtml(MODE_LABELS[s.mode] || s.mode)}</span><br>
            <span class="d">${s.pos}/${s.queue.length} · ${pct}% · ${date}</span>
          </span>
          <span class="n">▶</span>
        </button>
      `;
    }).join("");
    list.querySelectorAll("[data-sid]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const s = Storage.getSessionById(Number(btn.dataset.sid));
        if (s) resumeSession(s);
      });
    });
  }
  showScreen("sessions");
}
document.getElementById("btn-all-sessions").addEventListener("click", renderSessionsList);

// ---------------------------------------------------------------------
// GAMIFICATION — ranks, XP, streak and achievements.
// Everything here is derived from data already tracked in Storage
// (correct/wrong counters, session history) — no extra write-path
// through grade() is needed, which keeps this layer low-risk.
// ---------------------------------------------------------------------

const RANKS = [
  { id: "student", name: "Студент", icon: "🎓", floor: 0 },
  { id: "intern", name: "Интерн", icon: "🩺", floor: 500 },
  { id: "ordinator", name: "Ординатор", icon: "🩺", floor: 1500 },
  { id: "pharmacologist", name: "Фармаколог", icon: "⚗️", floor: 4000 },
  { id: "professor", name: "Профессор", icon: "🏅", floor: 8000 },
];

function sumEntries(entries, field) {
  return Object.values(entries).reduce((s, e) => s + (e[field] || 0), 0);
}

function computeXP() {
  const t = Storage.getAllEntries("test");
  const r = Storage.getAllEntries("recipe");
  return sumEntries(t, "correct") * 10 + sumEntries(r, "correct") * 15 + Storage.getBonusXP();
}

function computeRank(xp) {
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) if (xp >= RANKS[i].floor) idx = i;
  const cur = RANKS[idx];
  const next = RANKS[idx + 1] || null;
  return { idx, cur, next };
}

function prevDayISO(iso) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function computeStreak() {
  const hist = Storage.getHistory();
  const dateSet = new Set(hist.map((h) => h.date.slice(0, 10)));
  const today = Storage.todayISO();
  let cursor = today;
  if (!dateSet.has(cursor)) {
    const y = prevDayISO(cursor);
    if (!dateSet.has(y)) return { count: 0, dateSet, today };
    cursor = y;
  }
  let count = 0;
  while (dateSet.has(cursor)) { count++; cursor = prevDayISO(cursor); }
  return { count, dateSet, today };
}

function computeWeekStrip(dateSet, today) {
  const dayLabel = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    days.push({ label: dayLabel[d.getUTCDay()], filled: dateSet.has(iso) });
  }
  return days;
}

function computeAchievements() {
  const testsEntries = Storage.getAllEntries("test");
  const recipesEntries = Storage.getAllEntries("recipe");
  const testsSeen = Object.keys(testsEntries).length;
  const recipesSeen = Object.keys(recipesEntries).length;
  const totalReps = sumEntries(testsEntries, "correct") + sumEntries(testsEntries, "wrong")
    + sumEntries(recipesEntries, "correct") + sumEntries(recipesEntries, "wrong");
  const { count: streak } = computeStreak();
  const hist = Storage.getHistory();
  const last = hist[hist.length - 1] || null;
  const perfectSession = !!(last && last.wrong === 0 && last.total >= 10);
  const bestExam = Storage.getPeriodStats().bestExam;

  const topics = {};
  ALL_TESTS.forEach((q) => {
    (topics[q.topic] = topics[q.topic] || []).push(q.id);
  });
  let anyPerfectTopic = false;
  let allTopicsSeen = Object.keys(topics).length > 0;
  Object.values(topics).forEach((ids) => {
    let seenAll = true, perfectAll = true;
    ids.forEach((id) => {
      const e = testsEntries[id];
      const attempts = e ? e.correct + e.wrong : 0;
      if (attempts === 0) { seenAll = false; perfectAll = false; }
      else if (e.wrong > 0) perfectAll = false;
    });
    if (perfectAll) anyPerfectTopic = true;
    if (!seenAll) allTopicsSeen = false;
  });

  return [
    { id: "recipes_50", icon: "💊", name: "50 рецептов", desc: "Изучено 50 рецептов", done: recipesSeen >= 50 },
    { id: "recipes_all", icon: "⚗️", name: "Все рецепты", desc: `Изучены все ${ALL_RECIPES.length} рецептов`, done: ALL_RECIPES.length > 0 && recipesSeen >= ALL_RECIPES.length },
    { id: "streak_7", icon: "🔥", name: "7 дней подряд", desc: "Занимался 7 дней без перерыва", done: streak >= 7 },
    { id: "streak_30", icon: "🔥", name: "30 дней подряд", desc: "Занимался 30 дней без перерыва", done: streak >= 30 },
    { id: "perfect_topic", icon: "🎯", name: "Тема без ошибок", desc: "Хотя бы одна тема пройдена на 100%", done: anyPerfectTopic },
    { id: "perfect_session", icon: "✅", name: "Чистая сессия", desc: "Сессия из 10+ вопросов без единой ошибки", done: perfectSession },
    { id: "exam_95", icon: "🏅", name: "Экзамен 95%+", desc: "Экзамен сдан на 95% и выше", done: !!(bestExam && bestExam.pct >= 95) },
    { id: "all_topics", icon: "📚", name: "Все темы открыты", desc: "Хотя бы один вопрос в каждой теме", done: allTopicsSeen },
    { id: "reps_500", icon: "🔄", name: "500 повторений", desc: "500 решённых вопросов и рецептов суммарно", done: totalReps >= 500 },
  ];
}

function renderGamiStrip() {
  const xp = computeXP();
  const { cur, next } = computeRank(xp);
  const { count: streak, dateSet, today } = computeStreak();

  document.getElementById("gami-rank").innerHTML = `<span class="gami-rank-icon">${cur.icon}</span>${escapeHtml(cur.name)}`;
  document.getElementById("gami-streak").innerHTML = streak > 0 ? `🔥 ${streak}` : `🔥 0`;

  const floor = cur.floor;
  const ceiling = next ? next.floor : floor;
  const pct = next ? Math.round((100 * (xp - floor)) / (ceiling - floor)) : 100;
  document.getElementById("gami-vial-fill").style.height = `${Math.max(4, Math.min(100, pct))}%`;
  document.getElementById("gami-xp").textContent = next
    ? `${xp} / ${next.floor} XP`
    : `${xp} XP · максимальный ранг`;

  const week = computeWeekStrip(dateSet, today);
  document.getElementById("gami-week").innerHTML = week.map((d) => `
    <div class="gami-day">
      <div class="gami-day-dot ${d.filled ? "filled" : ""}">${d.filled ? "✓" : "·"}</div>
      <div class="gami-day-label">${d.label}</div>
    </div>
  `).join("");
}

function renderAchievements() {
  const xp = computeXP();
  const { cur, idx } = computeRank(xp);
  const defs = computeAchievements();
  const doneCount = defs.filter((d) => d.done).length;

  document.getElementById("card-ach-sub").textContent = `${doneCount} из ${defs.length}`;

  const grid = defs.map((d) => `
    <div class="seal">
      <div class="seal-circle ${d.done ? "gold" : "locked"}">${d.done ? d.icon : "🔒"}</div>
      <div class="seal-name">${escapeHtml(d.name)}</div>
    </div>
  `).join("");

  const track = RANKS.map((r, i) => `
    <div class="rank-step ${i < idx ? "done" : ""} ${i === idx ? "current" : ""}">
      <div class="rank-dot ${i < idx ? "done" : ""} ${i === idx ? "current" : ""}"></div>
      <div class="rank-step-name">${r.icon} ${escapeHtml(r.name)}</div>
    </div>
    ${i < RANKS.length - 1 ? '<div class="rank-line"></div>' : ""}
  `).join("");

  document.getElementById("ach-body").innerHTML = `
    <div class="ach-summary">
      <div class="ach-summary-title">${doneCount} из ${defs.length} получено</div>
    </div>
    <div class="seal-grid">${grid}</div>
    <div class="section-head"><span class="section-title">Врачебный путь</span></div>
    <div class="rank-track">${track}</div>
  `;
  showScreen("achievements");
}

function checkAndShowNewAchievements() {
  const defs = computeAchievements();
  const already = new Set(Storage.getUnlockedAchievements());
  const newly = defs.filter((d) => d.done && !already.has(d.id));
  if (!newly.length) return false;
  newly.forEach((d) => Storage.unlockAchievement(d.id));
  const d = newly[0];
  document.getElementById("unlock-seal").textContent = d.icon;
  document.getElementById("unlock-title").textContent = d.name;
  document.getElementById("unlock-desc").textContent = d.desc;
  showScreen("unlock");
  haptic("ok");
  return true;
}
document.getElementById("btn-unlock-close").addEventListener("click", () => renderHome());

// ---------------------------------------------------------------------
// THEORY — read-only reference material for the 2nd exam stage.
// Three fixed pools (билет = 1 вопрос из каждого) + a combined "all" view.
// Pure reading: no grading, no correctness tracking.
// ---------------------------------------------------------------------

const THEORY_POOLS = [
  { key: "q1", label: "Первый вопрос", icon: "1️⃣" },
  { key: "q2", label: "Второй вопрос", icon: "2️⃣" },
  { key: "q3", label: "Третий вопрос", icon: "3️⃣" },
];

function renderTheoryHub() {
  const total = THEORY_POOLS.reduce((s, p) => s + (ALL_THEORY[p.key] || []).length, 0);
  const tiles = THEORY_POOLS.map((p) => `
    <button class="card" data-theory-pool="${p.key}">
      <span class="card-icon">${p.icon}</span>
      <span class="card-title">${p.label}</span>
      <span class="card-sub">${(ALL_THEORY[p.key] || []).length} вопросов</span>
    </button>
  `).join("");

  document.getElementById("theory-hub-body").innerHTML = `
    ${tiles}
    <button class="card" data-theory-pool="all">
      <span class="card-icon">📚</span>
      <span class="card-title">Все материалы</span>
      <span class="card-sub">${total} вопросов подряд</span>
    </button>
  `;
  document.querySelectorAll("[data-theory-pool]").forEach((btn) => {
    btn.addEventListener("click", () => renderTheoryList(btn.dataset.theoryPool));
  });

  const searchInput = document.getElementById("theory-search-input");
  searchInput.value = "";
  document.getElementById("theory-search-results").classList.add("hidden");
  document.getElementById("theory-hub-body").classList.remove("hidden");

  showScreen("theory-hub");
}

function theoryFlatAll() {
  return THEORY_POOLS.flatMap((p) => (ALL_THEORY[p.key] || []).map((q) => ({ ...q, poolKey: p.key, poolLabel: p.label })));
}

function theorySearchResults(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return theoryFlatAll().filter((item) =>
    item.title.toLowerCase().includes(q) || item.body.toLowerCase().includes(q)
  );
}

function renderTheorySearchResults(query) {
  const resultsEl = document.getElementById("theory-search-results");
  const hubBody = document.getElementById("theory-hub-body");
  if (!query.trim()) {
    resultsEl.classList.add("hidden");
    resultsEl.innerHTML = "";
    hubBody.classList.remove("hidden");
    return;
  }
  hubBody.classList.add("hidden");
  resultsEl.classList.remove("hidden");
  const results = theorySearchResults(query);
  if (!results.length) {
    resultsEl.innerHTML = `<div class="theory-search-empty">Ничего не найдено</div>`;
    return;
  }
  resultsEl.innerHTML = results.map((item) => `
    <button class="theory-search-item" data-theory-pool="${item.poolKey}" data-theory-num="${item.num}">
      <span class="theory-search-item-pool">${escapeHtml(item.poolLabel)} · ${item.num}</span>
      <span class="theory-search-item-title">${escapeHtml(item.title)}</span>
    </button>
  `).join("");
  resultsEl.querySelectorAll(".theory-search-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      openTheoryAt(btn.dataset.theoryPool, Number(btn.dataset.theoryNum));
    });
  });
}

function openTheoryAt(poolKey, num) {
  const flat = theoryFlatAll();
  const idx = flat.findIndex((q) => q.poolKey === poolKey && q.num === num);
  theoryBook = { list: flat, index: Math.max(0, idx) };
  showScreen("theory-list");
  renderTheoryBookPage();
}

document.getElementById("theory-search-input").addEventListener("input", (e) => {
  renderTheorySearchResults(e.target.value);
});

function renderTheoryList(poolKey) {
  const list = poolKey === "all"
    ? THEORY_POOLS.flatMap((p) => (ALL_THEORY[p.key] || []).map((q) => ({ ...q, poolLabel: p.label })))
    : (ALL_THEORY[poolKey] || []).map((q) => ({ ...q, poolLabel: THEORY_POOLS.find((p) => p.key === poolKey).label }));
  theoryBook = { list, index: 0 };
  showScreen("theory-list");
  renderTheoryBookPage();
}

function parseTheorySections(body) {
  const parts = String(body).split(/\*\*(.+?)\*\*/g);
  const intro = (parts[0] || "").trim();
  const sections = [];
  for (let i = 1; i < parts.length; i += 2) {
    const header = (parts[i] || "").trim().replace(/[\s\-–:]+$/, "");
    const text = (parts[i + 1] || "").trim().replace(/^[\s\-–:]+/, "");
    if (header) sections.push({ header, text });
  }
  return { intro, sections };
}

function renderTheoryBookPage() {
  const { list, index } = theoryBook;
  const q = list[index];
  document.getElementById("theory-book-pool").textContent = q.poolLabel;
  document.getElementById("theory-book-pos").textContent = `${index + 1} / ${list.length}`;
  document.getElementById("theory-book-progress").style.width = `${Math.round((100 * (index + 1)) / list.length)}%`;

  const { intro, sections } = parseTheorySections(q.body);
  const charCount = sections.reduce((s, sec) => s + sec.text.length, intro.length);
  const minutes = Math.max(1, Math.round(charCount / 1000));
  const colorClasses = ["c0", "c1", "c2", "c3"];

  const sectionsHtml = sections.length
    ? sections.map((sec, i) => `
        <div class="tb-section ${colorClasses[i % 4]}">
          <div class="tb-section-header">${escapeHtml(sec.header)}</div>
          <div class="tb-section-text">${escapeHtml(sec.text)}</div>
        </div>
      `).join("")
    : `<div class="tb-section c0"><div class="tb-section-text">${escapeHtml(intro)}</div></div>`;

  document.getElementById("theory-book-page").innerHTML = `
    <div class="tb-eyebrow">${escapeHtml(q.poolLabel)} · вопрос ${q.num}</div>
    <div class="tb-title">${escapeHtml(q.title.replace(/\.$/, ""))}</div>
    <div class="tb-meta"><span>~${minutes} мин чтения</span><span>${sections.length || 1} раздел${sections.length === 1 ? "" : "а"}</span></div>
    ${sections.length ? `<div class="tb-intro">${escapeHtml(intro)}</div>` : ""}
    ${sectionsHtml}
  `;

  document.getElementById("theory-book-prev").disabled = index === 0;
  document.getElementById("theory-book-next").disabled = index === list.length - 1;
  document.getElementById("theory-book-page").scrollTop = 0;
}

document.getElementById("theory-book-prev").addEventListener("click", () => {
  if (theoryBook.index > 0) { theoryBook.index--; renderTheoryBookPage(); }
});
document.getElementById("theory-book-next").addEventListener("click", () => {
  if (theoryBook.index < theoryBook.list.length - 1) { theoryBook.index++; renderTheoryBookPage(); }
});

document.querySelector('[data-back="theory-hub"]').addEventListener("click", () => renderTheoryHub());




function resumeSession(saved) {
  session = { ...saved };
  document.getElementById("session-label").textContent = session.kind === "test" ? "тесты" : "рецепты";
  showScreen("session");
  startExamTimerIfNeeded();
  renderCurrent();
}

document.querySelectorAll("[data-nav]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const nav = btn.dataset.nav;
    if (nav === "tests") openModes("test");
    else if (nav === "recipes") openModes("recipe");
    else if (nav === "stats") renderStats();
    else if (nav === "errors") renderErrorsHub();
    else if (nav === "achievements") renderAchievements();
    else if (nav === "theory") renderTheoryHub();
    else if (nav === "settings") showScreen("settings");
  });
});

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const dest = btn.dataset.back;
    if (dest === "home") renderHome();
    else if (dest === "modes") {
      const fromSearch = !screens.search.classList.contains("hidden");
      openModes(fromSearch ? searchKind : (session ? session.kind : modesKind));
    }
  });
});

// ---------------------------------------------------------------------
// MODE SELECT
// ---------------------------------------------------------------------

let modesKind = "test";

function openModes(kind) {
  modesKind = kind;
  document.getElementById("modes-title").textContent = kind === "test" ? "Тесты" : "Рецепты";
  const total = allIds(kind).length;
  const errors = Storage.getErrorIds(kind).length;
  const favs = Storage.getFavoriteIds(kind).length;
  const due = Storage.getDueIds(kind, allIds(kind)).length;
  const seenCount = Storage.getSeenIds(kind).length;
  const todayN = Math.min(TODAY_SESSION_SIZE, due + (total - seenCount)) || Math.min(TODAY_SESSION_SIZE, total);

  const modes = [
    { key: "today", t: "▶ Заниматься", d: "Умная подборка: повтор + немного нового", n: todayN, highlight: true },
    { key: "sprint", t: "⏱ Спринт 5 минут", d: "Жёстко ограничен по времени — просто начни", n: "5:00", highlight: true },
    { key: "all", t: "Все", d: "Пройти весь банк по порядку", n: total },
    { key: "by_topic", t: "📚 По группам", d: "Выбрать фарм-группу и позаниматься только по ней", n: countTopics(kind) },
  ];
  if (kind === "recipe") {
    modes.push({ key: "confusables", t: "🔀 Путающиеся препараты", d: "Похожие по названию/действию — сравниваем в лоб", n: CONFUSABLE_GROUPS.length });
  }
  modes.push(
    { key: "exam", t: "Экзамен", d: `Билет: ${EXAM_SIZE[kind]} случайных`, n: Math.min(EXAM_SIZE[kind], total) },
    { key: "random", t: "Случайные", d: "Вразброс, без ограничений", n: total },
    { key: "errors", t: "Ошибки", d: "Только то, где были неверные ответы", n: errors, empty: errors === 0 },
    { key: "favorites", t: "Избранное", d: "Отмеченные звёздочкой", n: favs, empty: favs === 0 },
    { key: "review", t: "Повторение", d: "Пора повторить по графику", n: due, empty: due === 0 },
    { key: "learn", t: "👁 Просмотр", d: kind === "test" ? "Сразу с ответами, без проверки себя" : "Сразу с правильным рецептом", n: total },
  );

  const list = document.getElementById("mode-list");
  list.innerHTML = "";
  modes.forEach((m) => {
    const btn = document.createElement("button");
    btn.className = "mode-btn" + (m.highlight ? " mode-btn-highlight" : "");
    btn.disabled = !!m.empty;
    btn.innerHTML = `<span><span class="t">${m.t}</span><br><span class="d">${m.d}</span></span><span class="n">${m.n}</span>`;
    if (!m.empty) {
      btn.addEventListener("click", () => {
        if (m.key === "by_topic") openTopics(kind);
        else if (m.key === "confusables") openConfusables();
        else startSession(kind, m.key);
      });
    }
    list.appendChild(btn);
  });

  showScreen("modes");
}

function countTopics(kind) {
  const items = kind === "test" ? ALL_TESTS : ALL_RECIPES;
  return new Set(items.map((x) => x.topic || "Прочее")).size;
}

function openConfusables() {
  document.getElementById("topics-title").textContent = "Рецепты · путающиеся препараты";
  const list = document.getElementById("topic-list");
  list.innerHTML = "";

  const allBtn = document.createElement("button");
  allBtn.className = "mode-btn mode-btn-highlight";
  const allIdsCount = CONFUSABLE_GROUPS.reduce((s, g) => s + g.ids.length, 0);
  allBtn.innerHTML = `<span><span class="t">🔀 Все путающиеся, вперемешку</span><br><span class="d">Группы идут вразнобой, но внутри каждой — не подряд одинаковые</span></span><span class="n">${allIdsCount}</span>`;
  allBtn.addEventListener("click", () => {
    const shuffledGroups = shuffle(CONFUSABLE_GROUPS.map((g) => g.ids));
    startSession("recipe", "confusables", interleaveGroups(shuffledGroups, 2));
  });
  list.appendChild(allBtn);

  CONFUSABLE_GROUPS.forEach((g) => {
    const names = g.ids.map((id) => byId("recipe", id)?.name).filter(Boolean).join(" / ");
    const btn = document.createElement("button");
    btn.className = "mode-btn";
    btn.innerHTML = `<span><span class="t">${escapeHtml(names)}</span><br><span class="d">${escapeHtml(g.why)}</span></span><span class="n">${g.ids.length}</span>`;
    btn.addEventListener("click", () => startSession("recipe", "confusables", interleaveGroups([g.ids], 2)));
    list.appendChild(btn);
  });
  showScreen("topics");
}

function openTopics(kind) {
  const items = kind === "test" ? ALL_TESTS : ALL_RECIPES;
  const byTopic = {};
  items.forEach((x) => {
    const t = x.topic || "Прочее";
    (byTopic[t] = byTopic[t] || []).push(x.id);
  });
  const topicNames = Object.keys(byTopic).sort((a, b) => byTopic[b].length - byTopic[a].length);

  document.getElementById("topics-title").textContent = kind === "test" ? "Тесты · по группам" : "Рецепты · по группам";
  const list = document.getElementById("topic-list");
  list.innerHTML = "";
  topicNames.forEach((topic) => {
    const ids = byTopic[topic];
    const btn = document.createElement("button");
    btn.className = "mode-btn";
    btn.innerHTML = `<span><span class="t">${escapeHtml(topic)}</span></span><span class="n">${ids.length}</span>`;
    btn.addEventListener("click", () => startSession(kind, "topic", ids));
    list.appendChild(btn);
  });
  showScreen("topics");
}

function renderErrorsHub() {
  const errT = Storage.getErrorIds("test").length;
  const errR = Storage.getErrorIds("recipe").length;
  const list = document.getElementById("errors-list");
  list.innerHTML = "";
  [
    { kind: "test", label: "Тесты", n: errT },
    { kind: "recipe", label: "Рецепты", n: errR },
  ].forEach((row) => {
    const btn = document.createElement("button");
    btn.className = "mode-btn";
    btn.disabled = row.n === 0;
    btn.innerHTML = `<span><span class="t">${row.label}</span><br><span class="d">Прорешать вопросы с ошибками</span></span><span class="n">${row.n}</span>`;
    if (row.n > 0) btn.addEventListener("click", () => startSession(row.kind, "errors"));
    list.appendChild(btn);
  });
  showScreen("errors");
}

// ---------------------------------------------------------------------
// SESSION LIFECYCLE
// ---------------------------------------------------------------------

const TODAY_SESSION_SIZE = 25;

function buildQueue(kind, mode) {
  const ids = allIds(kind);
  switch (mode) {
    case "all": return ids.slice();
    case "learn": return ids.slice();
    case "random": return shuffle(ids);
    case "exam": return sample(ids, EXAM_SIZE[kind]);
    case "errors": return shuffle(Storage.getErrorIds(kind));
    case "favorites": return shuffle(Storage.getFavoriteIds(kind));
    case "review": return shuffle(Storage.getDueIds(kind, ids));
    case "today": return buildTodayQueue(kind, ids);
    case "sprint": return shuffle(ids); // timer decides when it ends, not queue length
    default: return shuffle(ids);
  }
}

function buildTodayQueue(kind, ids) {
  const due = shuffle(Storage.getDueIds(kind, ids));
  const seen = new Set(Storage.getSeenIds(kind));
  const fresh = shuffle(ids.filter((id) => !seen.has(id)));
  const queue = due.slice(0, TODAY_SESSION_SIZE);
  for (const id of fresh) {
    if (queue.length >= TODAY_SESSION_SIZE) break;
    queue.push(id);
  }
  return queue.length ? queue : shuffle(ids).slice(0, TODAY_SESSION_SIZE);
}

const EXAM_SECONDS = { test: 40 * 60, recipe: 20 * 60 }; // ~1 min/question
const SPRINT_SECONDS = 5 * 60;
let examTimerHandle = null;

function startSession(kind, mode, presetQueue) {
  const queue = presetQueue || buildQueue(kind, mode);
  session = { id: Date.now(), kind, mode, queue, pos: 0, correct: 0, wrong: 0, wrongIds: [], streak: 0, startedAt: new Date().toISOString() };
  document.getElementById("session-label").textContent = kind === "test" ? "тесты" : "рецепты";
  showScreen("session");
  startSessionTimerIfNeeded();
  startBreakReminderIfNeeded();
  renderCurrent();
}

function startSessionTimerIfNeeded() {
  stopExamTimer();
  const timerEl = document.getElementById("session-timer");
  const isExam = session.mode === "exam" && Storage.getSettings().examTimer;
  const isSprint = session.mode === "sprint";
  if (!isExam && !isSprint) {
    timerEl.classList.add("hidden");
    return;
  }
  timerEl.classList.remove("hidden");
  timerEl.classList.toggle("session-timer-sprint", isSprint);
  if (!session.examDeadline) {
    session.examDeadline = Date.now() + (isSprint ? SPRINT_SECONDS : EXAM_SECONDS[session.kind]) * 1000;
    persistSession();
  }
  const tick = () => {
    const left = Math.max(0, Math.round((session.examDeadline - Date.now()) / 1000));
    const m = String(Math.floor(left / 60)).padStart(2, "0");
    const s = String(left % 60).padStart(2, "0");
    timerEl.textContent = (isSprint ? "⏱ " : "") + `${m}:${s}`;
    timerEl.classList.toggle("warn", left <= 60);
    if (left <= 0) { stopExamTimer(); finishSession(); }
  };
  tick();
  examTimerHandle = setInterval(tick, 1000);
}
function stopExamTimer() {
  if (examTimerHandle) clearInterval(examTimerHandle);
  examTimerHandle = null;
}

let breakReminderHandle = null;
const BREAK_REMINDER_MINUTES = [15, 30, 45, 60, 75, 90];

function startBreakReminderIfNeeded() {
  stopBreakReminder();
  if (!Storage.getSettings().breakReminders) return;
  if (!session.breakRemindersShown) session.breakRemindersShown = [];
  breakReminderHandle = setInterval(() => {
    if (!session) return stopBreakReminder();
    const elapsedMin = Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 60000);
    const due = BREAK_REMINDER_MINUTES.find((m) => elapsedMin >= m && !session.breakRemindersShown.includes(m));
    if (due) {
      session.breakRemindersShown.push(due);
      persistSession();
      showToast(`🌿 Ты уже ${due} мин. в деле — самое время на пару минут выдохнуть`, "break", 4200);
    }
  }, 30000);
}
function stopBreakReminder() {
  if (breakReminderHandle) clearInterval(breakReminderHandle);
  breakReminderHandle = null;
}

function updateCounter() {
  document.getElementById("session-counter").textContent = `${session.pos + 1} / ${session.queue.length}`;
  const pct = Math.round((100 * session.pos) / session.queue.length);
  document.getElementById("session-progress-fill").style.width = `${pct}%`;
}

function persistSession() {
  if (!session) return;
  Storage.saveSession({ ...session });
}

function renderCurrent() {
  if (session.pos >= session.queue.length) return finishSession();
  updateCounter();
  persistSession();
  const area = document.getElementById("card-area");
  area.innerHTML = ""; // hard reset: guarantees nothing from the previous question (a stray node,
                        // a leftover "ghost" character) can survive into the next render
  const id = session.queue[session.pos];
  const item = byId(session.kind, id);

  if (session.mode === "learn") {
    if (session.kind === "test") renderTestLearnCard(area, item);
    else renderRecipeLearnCard(area, item);
    renderMnemonicBox(area, session.kind, id);
    return;
  }
  if (session.kind === "test") renderTestCard(area, item);
  else renderRecipeCard(area, item);
  renderMnemonicBox(area, session.kind, id);
  renderSessionNav(area);
}

/** Personal mnemonic/association note, shown under every card (tests + recipes, all modes). */
function renderMnemonicBox(area, kind, id) {
  if (!Storage.getSettings().mnemonics) return;
  const slip = area.querySelector(".slip") || area;

  const box = document.createElement("div");
  box.className = "mnemonic-box";

  const renderView = () => {
    box.innerHTML = "";
    const text = Storage.getMnemonic(kind, id);
    if (text) {
      const note = document.createElement("div");
      note.className = "mnemonic-note";
      note.innerHTML = `<span class="mnemonic-note-label">📝 Моя мнемоника</span><div class="mnemonic-note-text"></div>`;
      note.querySelector(".mnemonic-note-text").textContent = text;
      const editBtn = document.createElement("button");
      editBtn.className = "mnemonic-edit-btn";
      editBtn.textContent = "✏️";
      editBtn.addEventListener("click", renderEdit);
      note.appendChild(editBtn);
      box.appendChild(note);
    } else {
      const addBtn = document.createElement("button");
      addBtn.className = "mnemonic-add-btn";
      addBtn.textContent = "📝 + Добавить мнемонику";
      addBtn.addEventListener("click", renderEdit);
      box.appendChild(addBtn);
    }
  };

  const renderEdit = () => {
    box.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "mnemonic-edit";
    const ta = document.createElement("textarea");
    ta.className = "mnemonic-textarea";
    ta.placeholder = "Своя ассоциация, стишок, зацепка для памяти…";
    ta.value = Storage.getMnemonic(kind, id);
    wrap.appendChild(ta);
    const row = document.createElement("div");
    row.className = "mnemonic-edit-row";
    const saveBtn = document.createElement("button");
    saveBtn.className = "mnemonic-save-btn";
    saveBtn.textContent = "Сохранить";
    saveBtn.addEventListener("click", () => {
      Storage.setMnemonic(kind, id, ta.value);
      renderView();
    });
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "mnemonic-cancel-btn";
    cancelBtn.textContent = "Отмена";
    cancelBtn.addEventListener("click", renderView);
    row.appendChild(saveBtn);
    row.appendChild(cancelBtn);
    wrap.appendChild(row);
    box.appendChild(wrap);
    ta.focus();
  };

  renderView();
  slip.appendChild(box);
}

/** Back (prev question, "Все" mode only) + Skip controls shown under every card. */
function renderSessionNav(area) {
  const old = document.getElementById("session-nav");
  if (old) old.remove();
  const nav = document.createElement("div");
  nav.id = "session-nav";
  nav.className = "session-nav";

  const canGoBack = session.mode === "all" && session.pos > 0;
  if (canGoBack) {
    const backBtn = document.createElement("button");
    backBtn.className = "session-nav-btn";
    backBtn.textContent = "← Предыдущий";
    backBtn.addEventListener("click", () => { session.pos--; renderCurrent(); });
    nav.appendChild(backBtn);
  } else {
    nav.appendChild(document.createElement("span"));
  }

  const skipBtn = document.createElement("button");
  skipBtn.className = "session-nav-btn";
  skipBtn.textContent = "Пропустить →";
  skipBtn.addEventListener("click", () => { session.pos++; renderCurrent(); });
  nav.appendChild(skipBtn);
  area.appendChild(nav);
}

function praiseMessage(pct, total) {
  const name = (Storage.getSettings().userName || "").trim();
  const who = name ? `, ${name}` : "";
  if (total === 0) return "Ну что, начнём?";
  if (pct >= 90) return `Отлично${who}! Практически всё верно 🔥`;
  if (pct >= 70) return `Хороший результат${who}! Ты почти у цели 👏`;
  if (pct >= 50) return `Неплохо${who}, но есть над чем поработать 💪`;
  return `Не расстраивайся${who} — разбери ошибки и попробуй снова 📚`;
}

function finishSession() {
  stopExamTimer();
  stopBreakReminder();
  const isLearnMode = session.mode === "learn";
  const total = session.correct + session.wrong;
  const pct = total ? Math.round((100 * session.correct) / total) : 0;
  if (!isLearnMode) Storage.recordSession(session.kind, session.mode, total, session.correct, session.wrong);
  Storage.deleteSession(session.id);
  if (isLearnMode) {
    document.getElementById("result-mark").textContent = "✓";
    document.getElementById("result-praise").textContent = "Просмотрено";
    document.getElementById("result-text").textContent = `Карточек просмотрено: ${session.queue.length}`;
  } else {
    document.getElementById("result-mark").textContent = pct >= 70 ? "✓" : "";
    document.getElementById("result-praise").textContent =
      session.mode === "sprint" ? "⏱ Спринт окончен!" : praiseMessage(pct, total);
    document.getElementById("result-text").textContent =
      `Пройдено: ${total}\nВерно: ${session.correct}  ·  Неверно: ${session.wrong}\nТочность: ${pct}%`;
  }
  haptic(pct >= 70 ? "ok" : "tap");
  const reviewBtn = document.getElementById("btn-review-errors");
  if (session.wrong > 0) {
    reviewBtn.classList.remove("hidden");
    // Review only what was actually missed THIS session, not the all-time error bank
    // (that's what "errors" mode normally pulls from buildQueue/Storage.getErrorIds).
    const sessionKind = session.kind;
    const sessionWrongIds = shuffle([...new Set(session.wrongIds)]);
    reviewBtn.onclick = () => startSession(sessionKind, "errors", sessionWrongIds);
  } else {
    reviewBtn.classList.add("hidden");
  }
  document.getElementById("btn-retry").onclick = () => startSession(session.kind, session.mode);
  showScreen("result");
}
document.getElementById("btn-again").addEventListener("click", () => { session = null; renderHome(); });

/**
 * "Мне лень выбирать" — zero-decision entry point. Picks whichever kind has
 * more overdue reviews right now (spaced repetition matters more than
 * novelty), falls back to a coin flip if both are equally (un)caught-up, and
 * launches straight into the adaptive "Заниматься" queue — no menus at all.
 */
document.getElementById("btn-lazy").addEventListener("click", () => {
  const dueTest = Storage.getDueIds("test", allIds("test")).length;
  const dueRecipe = Storage.getDueIds("recipe", allIds("recipe")).length;
  let kind;
  if (dueTest === dueRecipe) kind = Math.random() < 0.5 ? "test" : "recipe";
  else kind = dueTest > dueRecipe ? "test" : "recipe";
  haptic("tap");
  startSession(kind, "today");
});

function favToggleHtml(kind, id) {
  const active = Storage.isFavorite(kind, id);
  return `<button class="fav-btn ${active ? "active" : ""}" data-fav="${kind}:${id}">${active ? "★" : "☆"}</button>`;
}
function wireFavButton(area) {
  const btn = area.querySelector("[data-fav]");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const [kind, id] = btn.dataset.fav.split(":");
    const active = Storage.toggleFavorite(kind, Number(id));
    btn.textContent = active ? "★" : "☆";
    btn.classList.toggle("active", active);
    haptic("tap");
  });
}

// Detects common instructional prefixes ("Укажите правильный ответ.", "Укажите
// соответствие.", "Впишите недостающее слово." и т.п.) and puts the actual
// question on its own line below them, instead of running them together.
const QUESTION_PREFIX_RE = /^(Укажите (?:правильны[ей]|неправильны[ей]|ошибк[а-яё]*) ответ[а-яё]*|Укажите соответстви[ея]|Впишите недостающее слово(?:\s*\([^)]*\))?|Вставьте недостающ[а-яё]+ слов[а-яё]+)\s*[.!]+\s*/i;

function formatQuestionText(text) {
  text = (text || "").trim();
  const m = text.match(QUESTION_PREFIX_RE);
  if (!m) return escapeHtml(text);
  const rest = text.slice(m[0].length).trim();
  if (!rest) return escapeHtml(text);
  const punct = m[0].trim().endsWith("!") ? "!" : ".";
  return `${escapeHtml(m[1])}${punct}<br><br>${escapeHtml(rest)}`;
}

function explanationHtml(q) {
  if (!q.explanation || !Storage.getSettings().showExplanations) return "";
  return `<div class="explain-box"><div class="explain-label">💡 Объяснение</div><div class="explain-text">${escapeHtml(q.explanation)}</div></div>`;
}

function addNextButton(area) {
  const btn = document.createElement("button");
  btn.className = "btn-primary";
  btn.style.marginTop = "14px";
  btn.textContent = "Следующий вопрос →";
  btn.addEventListener("click", () => { session.pos++; renderCurrent(); });
  area.querySelector(".slip").appendChild(btn);
}

function haptic(kind) {
  if (tg && tg.HapticFeedback) {
    if (kind === "ok") tg.HapticFeedback.notificationOccurred("success");
    else if (kind === "bad") tg.HapticFeedback.notificationOccurred("error");
    else tg.HapticFeedback.impactOccurred("light");
  }
}

function grade(kind, id, ok) {
  Storage.recordResult(kind, id, ok);
  if (ok) { session.correct++; session.streak = (session.streak || 0) + 1; }
  else { session.wrong++; session.wrongIds.push(id); session.streak = 0; }
  haptic(ok ? "ok" : "bad");
  persistSession();
  showConfidencePrompt(kind, id, ok);
  if (ok) celebrateIfDeserved();
}

const STREAK_MILESTONES = { 3: "🔥 3 подряд!", 5: "🔥🔥 5 подряд, огонь!", 8: "🔥🔥🔥 8 подряд — не могу поверить", 12: "⚡ 12 подряд! Ты в потоке", 20: "🚀 20 подряд?! Легенда." };
const BONUS_XP_CHANCE = 0.15; // a deliberately unpredictable reward — variable-ratio schedules are the ones that actually keep attention

/** Streak milestone toast and/or a random surprise-XP toast, on top of the normal grading. */
function celebrateIfDeserved() {
  const streak = session.streak || 0;
  if (STREAK_MILESTONES[streak]) {
    showToast(STREAK_MILESTONES[streak], "streak");
    return; // don't stack a bonus-XP toast on the same beat — one dopamine hit at a time
  }
  if (Math.random() < BONUS_XP_CHANCE) {
    const amount = 5 + Math.floor(Math.random() * 16); // 5–20
    Storage.addBonusXP(amount);
    showToast(`🎁 Бонус +${amount} XP!`, "bonus");
  }
}

/** Small floating non-blocking celebration toast, top of screen, auto-dismisses. */
function showToast(text, kind, durationMs) {
  const host = document.getElementById("toast-host");
  if (!host) return;
  const ms = durationMs || 1400;
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = text;
  host.appendChild(el);
  haptic("tap");
  setTimeout(() => el.classList.add("toast-out"), ms);
  setTimeout(() => el.remove(), ms + 300);
}

/**
 * Small non-blocking "were you sure?" prompt shown right after every graded
 * answer, across all question/recipe types. Tapping either button (or simply
 * moving on without tapping) is fine — it's just a self-report for the
 * calibration stats, not a gate on continuing.
 */
function showConfidencePrompt(kind, id, ok) {
  if (!Storage.getSettings().confidence) return;
  const slip = document.querySelector(".slip");
  if (!slip) return;

  const box = document.createElement("div");
  box.className = "confidence-box";
  box.innerHTML = `
    <span class="confidence-q">Ты был уверен в ответе?</span>
    <div class="confidence-btns">
      <button class="confidence-btn confidence-yes">😎 Да, уверен</button>
      <button class="confidence-btn confidence-no">🤔 Сомневался</button>
    </div>
  `;
  const answerNow = (confident) => {
    Storage.recordConfidence(kind, id, ok, confident);
    box.innerHTML = `<span class="confidence-done">Записал, спасибо 🙌</span>`;
    setTimeout(() => box.remove(), 900);
  };
  box.querySelector(".confidence-yes").addEventListener("click", () => answerNow(true));
  box.querySelector(".confidence-no").addEventListener("click", () => answerNow(false));
  slip.appendChild(box);
}

// ---------------------------------------------------------------------
// TEST CARD RENDERING
// ---------------------------------------------------------------------

function renderTestCard(area, q) {
  if (q.type === "choice") renderChoiceCard(area, q);
  else if (q.type === "matching" || q.type === "table") renderMatchingCard(area, q);
  else if (q.type === "characterize") renderCharacterizeCard(area, q);
  else if (q.type === "fill_blank" && q.blanks) renderFillBlankCard(area, q);
  else if (q.type === "fill_blank_simple") renderFillBlankSimpleCard(area, q);
  else renderFlashcardTestCard(area, q);
}

function slipHeader(kicker, kind, id) {
  return `<div class="slip-top"><span class="slip-kicker">${kicker}</span><span class="slip-top-right">${memoryRingHtml(kind, id)}${favToggleHtml(kind, id)}</span></div>`;
}

/**
 * Small ring showing SM-2 "memory strength" (100% = just reviewed, drains to
 * 0% as the next scheduled review date approaches/passes). Returns "" (nothing
 * rendered) for cards never graded yet, since there's no schedule to show.
 */
function memoryRingHtml(kind, id) {
  const pct = Storage.getMemoryStrength(kind, id);
  if (pct === null) return "";
  const r = 8, c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  const color = pct >= 60 ? "var(--green)" : pct >= 25 ? "var(--amber)" : "var(--red)";
  const title = pct <= 0 ? "Пора повторить" : `Сила памяти: ${pct}%`;
  return `<svg class="mem-ring" viewBox="0 0 20 20" title="${title}">
    <circle cx="10" cy="10" r="${r}" fill="none" stroke="var(--border)" stroke-width="2.5"></circle>
    <circle cx="10" cy="10" r="${r}" fill="none" stroke="${color}" stroke-width="2.5"
      stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}" stroke-linecap="round"
      transform="rotate(-90 10 10)"></circle>
  </svg>`;
}

function renderChoiceCard(area, q) {
  const selected = new Set();
  area.innerHTML = `
    <div class="slip">
      ${slipHeader("Вопрос с вариантами", "test", q.id)}
      <div class="slip-question">${formatQuestionText(q.question)}</div>
      <div class="options" id="opts"></div>
      <div id="verdict"></div>
    </div>
  `;
  wireFavButton(area);
  const optsEl = area.querySelector("#opts");
  const displayOptions = Storage.getSettings().shuffleAnswers ? shuffle(q.options) : q.options;
  displayOptions.forEach((opt, i) => {
    const btn = document.createElement("button");
    btn.className = "opt";
    btn.innerHTML = `<span class="opt-label">${OPTION_LABELS[i] || i + 1}</span><span>${escapeHtml(opt.text)}</span>`;
    btn.addEventListener("click", () => {
      if (q.multi) {
        btn.classList.toggle("selected");
        if (selected.has(i)) selected.delete(i); else selected.add(i);
      } else {
        [...optsEl.children].forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        selected.clear(); selected.add(i);
      }
      updateAnswerButton();
    });
    optsEl.appendChild(btn);
  });

  const answerBtn = document.createElement("button");
  answerBtn.className = "btn-primary";
  answerBtn.style.marginTop = "14px";
  answerBtn.textContent = "Ответить";
  answerBtn.disabled = true;
  answerBtn.addEventListener("click", () => doGrade());
  area.querySelector(".slip").appendChild(answerBtn);

  function updateAnswerButton() { answerBtn.disabled = selected.size === 0; }

  function doGrade() {
    const correctIdx = new Set(displayOptions.map((o, i) => (o.correct ? i : -1)).filter((i) => i >= 0));
    const ok = correctIdx.size === selected.size && [...correctIdx].every((i) => selected.has(i));
    [...optsEl.children].forEach((btn, i) => {
      btn.disabled = true;
      if (correctIdx.has(i)) btn.classList.add("correct");
      else if (selected.has(i)) btn.classList.add("incorrect");
    });
    grade("test", q.id, ok);
    const v = area.querySelector("#verdict");
    v.innerHTML = `<div class="verdict ${ok ? "ok" : "no"}">${ok ? "✓ Правильно" : "✕ Неправильно"}</div>` + explanationHtml(q);
    answerBtn.remove();
    addNextButton(area);
  }
}

function renderMatchingCard(area, q) {
  const style = Storage.getSettings().matchingStyle || "cards";
  if (style === "list") renderMatchingCardList(area, q);
  else if (style === "lines") renderMatchingCardLines(area, q);
  else renderMatchingCardCards(area, q);
}

// ---- shared grading: q.answer[i] is now an array of correct category indices ----
function matchingIsRowCorrect(picksSet, correctArr) {
  if (picksSet.size !== correctArr.length) return false;
  return correctArr.every((c) => picksSet.has(c));
}

// ---- Style A: cards with toggleable pick chips (multi-select) ----
function renderMatchingCardCards(area, q) {
  area.innerHTML = `
    <div class="slip">
      ${slipHeader(q.type === "matching" ? "Соответствие" : "Классификация", "test", q.id)}
      <div class="slip-question">${formatQuestionText(q.question)}</div>
      <div class="legend" id="legend"></div>
      <div class="match-list" id="rows"></div>
      <div id="verdict"></div>
    </div>
  `;
  wireFavButton(area);
  const legend = area.querySelector("#legend");
  q.categories.forEach((c, i) => {
    legend.innerHTML += `<span class="legend-chip"><span class="legend-num">${i + 1}</span>${escapeHtml(c)}</span>`;
  });
  const rows = area.querySelector("#rows");
  const picks = q.items.map(() => new Set());
  q.items.forEach((item, i) => {
    const row = document.createElement("div");
    row.className = "match-row";
    row.innerHTML = `<div class="match-item">${escapeHtml(item)}</div><div class="match-picks"></div>`;
    const picksEl = row.querySelector(".match-picks");
    q.categories.forEach((c, catIdx) => {
      const b = document.createElement("button");
      b.className = "pick-btn";
      b.textContent = catIdx + 1;
      b.addEventListener("click", () => {
        if (picks[i].has(catIdx)) { picks[i].delete(catIdx); b.classList.remove("picked"); }
        else { picks[i].add(catIdx); b.classList.add("picked"); }
        maybeShowAnswerBtn();
      });
      picksEl.appendChild(b);
    });
    rows.appendChild(row);
  });

  function maybeShowAnswerBtn() {
    const allFilled = picks.every((p) => p.size > 0);
    if (allFilled && !area.querySelector(".btn-primary")) {
      const btn = document.createElement("button");
      btn.className = "btn-primary";
      btn.style.marginTop = "4px";
      btn.textContent = "Ответить";
      btn.addEventListener("click", doGrade);
      area.querySelector(".slip").appendChild(btn);
    } else if (!allFilled) {
      const existing = area.querySelector(".btn-primary");
      if (existing) existing.remove();
    }
  }

  function doGrade() {
    let allOk = true;
    [...rows.children].forEach((row, i) => {
      const ok = matchingIsRowCorrect(picks[i], q.answer[i]);
      if (!ok) allOk = false;
      row.classList.add(ok ? "row-ok" : "row-no");
      [...row.querySelectorAll(".pick-btn")].forEach((b) => (b.disabled = true));
      if (!ok) {
        const correctNames = q.answer[i].map((idx) => `${idx + 1}. ${escapeHtml(q.categories[idx])}`).join(", ");
        row.innerHTML += `<div class="row-hint">Верно: <b>${correctNames}</b></div>`;
      }
    });
    grade("test", q.id, allOk);
    area.querySelector(".btn-primary").remove();
    area.querySelector("#verdict").innerHTML =
      `<div class="verdict ${allOk ? "ok" : "no"}">${allOk ? "✓ Всё верно" : "✕ Есть ошибки"}</div>` + explanationHtml(q);
    addNextButton(area);
  }
}

// ---- Style B: list / accordion — one category open at a time, checkboxes for terms ----
function renderMatchingCardList(area, q) {
  area.innerHTML = `
    <div class="slip">
      ${slipHeader(q.type === "matching" ? "Соответствие" : "Классификация", "test", q.id)}
      <div class="slip-question">${formatQuestionText(q.question)}</div>
      <div class="match-acc" id="acc"></div>
      <div id="verdict"></div>
    </div>
  `;
  wireFavButton(area);
  const acc = area.querySelector("#acc");
  const picks = q.items.map(() => new Set());
  let openIdx = 0;

  function renderAcc() {
    acc.innerHTML = "";
    q.items.forEach((item, i) => {
      const isOpen = openIdx === i;
      const count = picks[i].size;
      const wrap = document.createElement("div");
      wrap.className = "acc-item" + (isOpen ? " open" : "");
      wrap.innerHTML = `
        <div class="acc-head">
          <span class="acc-title">${escapeHtml(item)}</span>
          <span class="acc-badge ${count ? "done" : ""}">${count ? count + " выбрано" : "открыть"}</span>
        </div>
        <div class="acc-body"></div>
      `;
      wrap.querySelector(".acc-head").addEventListener("click", () => {
        openIdx = isOpen ? -1 : i;
        renderAcc();
      });
      const body = wrap.querySelector(".acc-body");
      q.categories.forEach((c, catIdx) => {
        const on = picks[i].has(catIdx);
        const rowEl = document.createElement("div");
        rowEl.className = "check-row";
        rowEl.innerHTML = `<span class="check-box ${on ? "on" : ""}">${on ? "✓" : ""}</span> ${escapeHtml(c)}`;
        rowEl.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (picks[i].has(catIdx)) picks[i].delete(catIdx); else picks[i].add(catIdx);
          openIdx = i;
          renderAcc();
          maybeShowAnswerBtn();
        });
        body.appendChild(rowEl);
      });
      acc.appendChild(wrap);
    });
  }
  renderAcc();

  function maybeShowAnswerBtn() {
    const allFilled = picks.every((p) => p.size > 0);
    if (allFilled && !area.querySelector(".btn-primary")) {
      const btn = document.createElement("button");
      btn.className = "btn-primary";
      btn.style.marginTop = "4px";
      btn.textContent = "Ответить";
      btn.addEventListener("click", doGrade);
      area.querySelector(".slip").appendChild(btn);
    } else if (!allFilled) {
      const existing = area.querySelector(".btn-primary");
      if (existing) existing.remove();
    }
  }

  function doGrade() {
    let allOk = true;
    [...acc.children].forEach((wrap, i) => {
      const ok = matchingIsRowCorrect(picks[i], q.answer[i]);
      if (!ok) allOk = false;
      wrap.classList.add(ok ? "row-ok" : "row-no");
      wrap.querySelectorAll(".check-row").forEach((r) => (r.style.pointerEvents = "none"));
      if (!ok) {
        const correctNames = q.answer[i].map((idx) => `${idx + 1}. ${escapeHtml(q.categories[idx])}`).join(", ");
        wrap.innerHTML += `<div class="row-hint" style="padding:0 16px 12px;">Верно: <b>${correctNames}</b></div>`;
      }
    });
    grade("test", q.id, allOk);
    area.querySelector(".btn-primary").remove();
    area.querySelector("#verdict").innerHTML =
      `<div class="verdict ${allOk ? "ok" : "no"}">${allOk ? "✓ Всё верно" : "✕ Есть ошибки"}</div>` + explanationHtml(q);
    addNextButton(area);
  }
}

// ---- Style C: connect-the-lines — tap item on left, then category on right ----
function renderMatchingCardLines(area, q) {
  area.innerHTML = `
    <div class="slip">
      ${slipHeader(q.type === "matching" ? "Соответствие" : "Классификация", "test", q.id)}
      <div class="slip-question">${formatQuestionText(q.question)}</div>
      <div class="lines-hint">Тапни термин слева, потом группу справа</div>
      <div class="lines-wrap" id="lines-wrap">
        <svg class="lines-svg" id="lines-svg"></svg>
        <div class="lines-col" id="lines-left"></div>
        <div class="lines-col" id="lines-right"></div>
      </div>
      <div id="verdict"></div>
    </div>
  `;
  wireFavButton(area);

  const leftEl = area.querySelector("#lines-left");
  const rightEl = area.querySelector("#lines-right");
  const svg = area.querySelector("#lines-svg");
  const wrap = area.querySelector("#lines-wrap");

  const picks = q.items.map(() => new Set());
  let selectedLeft = null;
  let graded = false;

  function renderNodes() {
    leftEl.innerHTML = q.items.map((item, i) => {
      const hasAny = picks[i].size > 0;
      return `<div class="line-node ${selectedLeft === i ? "active" : ""} ${hasAny ? "has-line" : ""}" data-side="left" data-idx="${i}">${escapeHtml(item)}</div>`;
    }).join("");
    rightEl.innerHTML = q.categories.map((cat, ci) => {
      const used = picks.some((p) => p.has(ci));
      return `<div class="line-node ${used ? "has-line" : ""}" data-side="right" data-idx="${ci}">${escapeHtml(cat)}</div>`;
    }).join("");

    leftEl.querySelectorAll(".line-node").forEach((node) => {
      node.addEventListener("click", () => {
        if (graded) return;
        const i = Number(node.dataset.idx);
        selectedLeft = selectedLeft === i ? null : i;
        renderNodes();
      });
    });
    rightEl.querySelectorAll(".line-node").forEach((node) => {
      node.addEventListener("click", () => {
        if (graded || selectedLeft === null) return;
        const ci = Number(node.dataset.idx);
        const s = picks[selectedLeft];
        if (s.has(ci)) s.delete(ci); else s.add(ci);
        renderNodes();
        maybeShowAnswerBtn();
      });
    });
    drawLines();
  }

  function drawLines() {
    const wrapRect = wrap.getBoundingClientRect();
    svg.setAttribute("width", wrapRect.width);
    svg.setAttribute("height", wrapRect.height);
    let html = "";
    picks.forEach((set, i) => {
      const lNode = leftEl.children[i];
      set.forEach((ci) => {
        const rNode = rightEl.children[ci];
        if (!lNode || !rNode) return;
        const l = lNode.getBoundingClientRect(), r = rNode.getBoundingClientRect();
        const x1 = l.right - wrapRect.left, y1 = l.top - wrapRect.top + l.height / 2;
        const x2 = r.left - wrapRect.left, y2 = r.top - wrapRect.top + r.height / 2;
        const cls = graded ? (lineOk(i) ? "ok" : "no") : "";
        html += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}" />`;
      });
    });
    svg.innerHTML = html;
  }

  function lineOk(i) {
    return matchingIsRowCorrect(picks[i], q.answer[i]);
  }

  function maybeShowAnswerBtn() {
    const allFilled = picks.every((p) => p.size > 0);
    if (allFilled && !area.querySelector(".btn-primary")) {
      const btn = document.createElement("button");
      btn.className = "btn-primary";
      btn.style.margin = "12px 18px 0";
      btn.textContent = "Ответить";
      btn.addEventListener("click", doGrade);
      area.querySelector(".slip").appendChild(btn);
    } else if (!allFilled) {
      const existing = area.querySelector(".btn-primary");
      if (existing) existing.remove();
    }
  }

  function doGrade() {
    graded = true;
    selectedLeft = null;
    let allOk = true;
    q.items.forEach((_, i) => { if (!lineOk(i)) allOk = false; });
    renderNodes();
    [...leftEl.children, ...rightEl.children].forEach((n) => n.classList.add("locked"));
    if (!allOk) {
      const hintLines = q.items.map((item, i) => {
        if (lineOk(i)) return "";
        const names = q.answer[i].map((idx) => `${idx + 1}. ${escapeHtml(q.categories[idx])}`).join(", ");
        return `<div class="row-hint">${escapeHtml(item)} → <b>${names}</b></div>`;
      }).join("");
      area.querySelector(".slip").insertAdjacentHTML("beforeend", `<div class="lines-hints">${hintLines}</div>`);
    }
    grade("test", q.id, allOk);
    area.querySelector(".btn-primary").remove();
    area.querySelector("#verdict").innerHTML =
      `<div class="verdict ${allOk ? "ok" : "no"}">${allOk ? "✓ Всё верно" : "✕ Есть ошибки"}</div>` + explanationHtml(q);
    addNextButton(area);
  }

  renderNodes();
  if (window.__linesResizeHandler) window.removeEventListener("resize", window.__linesResizeHandler);
  window.__linesResizeHandler = drawLines;
  window.addEventListener("resize", window.__linesResizeHandler);
}

function renderCharacterizeCard(area, q) {
  area.innerHTML = `
    <div class="slip">
      ${slipHeader("Охарактеризуйте", "test", q.id)}
      <div class="slip-question">${formatQuestionText(q.question)}</div>
      <div id="axes"></div>
      <div id="verdict"></div>
    </div>
  `;
  wireFavButton(area);
  const axesEl = area.querySelector("#axes");
  const picks = new Array(q.axes.length).fill(null);
  q.axes.forEach((axis, ai) => {
    const block = document.createElement("div");
    block.className = "axis-block";
    block.innerHTML = `<div class="axis-label">${escapeHtml(axis.label)}</div>`;
    axis.options.forEach((opt, oi) => {
      const b = document.createElement("button");
      b.className = "opt axis-opt";
      b.innerHTML = `<span>${escapeHtml(opt)}</span>`;
      b.addEventListener("click", () => {
        picks[ai] = oi;
        [...block.querySelectorAll(".axis-opt")].forEach((x) => x.classList.remove("selected"));
        b.classList.add("selected");
        maybeShowAnswerBtn();
      });
      block.appendChild(b);
    });
    axesEl.appendChild(block);
  });

  function maybeShowAnswerBtn() {
    if (picks.every((p) => p !== null) && !area.querySelector(".btn-primary")) {
      const btn = document.createElement("button");
      btn.className = "btn-primary";
      btn.style.marginTop = "4px";
      btn.textContent = "Ответить";
      btn.addEventListener("click", doGrade);
      area.querySelector(".slip").appendChild(btn);
    }
  }

  function doGrade() {
    let allOk = true;
    const blocks = axesEl.querySelectorAll(".axis-block");
    blocks.forEach((block, ai) => {
      const ok = picks[ai] === q.axes[ai].correct;
      if (!ok) allOk = false;
      [...block.querySelectorAll(".axis-opt")].forEach((b, oi) => {
        b.disabled = true;
        if (oi === q.axes[ai].correct) b.classList.add("correct");
        else if (oi === picks[ai]) b.classList.add("incorrect");
      });
    });
    grade("test", q.id, allOk);
    area.querySelector(".btn-primary").remove();
    area.querySelector("#verdict").innerHTML =
      `<div class="verdict ${allOk ? "ok" : "no"}">${allOk ? "✓ Всё верно" : "✕ Есть ошибки"}</div>` + explanationHtml(q);
    addNextButton(area);
  }
}

function renderFillBlankCard(area, q) {
  area.innerHTML = `
    <div class="slip">
      ${slipHeader("Вставьте пропущенное", "test", q.id)}
      <div class="slip-question">${formatQuestionText(q.question)}</div>
      <div id="blanks"></div>
      <div id="verdict"></div>
    </div>
  `;
  wireFavButton(area);
  const blanksEl = area.querySelector("#blanks");
  const picks = new Array(q.blanks.length).fill(null);
  q.blanks.forEach((options, bIdx) => {
    const block = document.createElement("div");
    block.className = "axis-block";
    block.innerHTML = `<div class="axis-label">Пропуск ${bIdx + 1}</div>`;
    const isMulti = options.filter((o) => o.correct).length > 1;
    const chosen = new Set();
    options.forEach((opt, oIdx) => {
      const b = document.createElement("button");
      b.className = "opt axis-opt";
      b.innerHTML = `<span>${escapeHtml(opt.text)}</span>`;
      b.addEventListener("click", () => {
        if (isMulti) {
          b.classList.toggle("selected");
          if (chosen.has(oIdx)) chosen.delete(oIdx); else chosen.add(oIdx);
          picks[bIdx] = [...chosen];
        } else {
          [...block.querySelectorAll(".axis-opt")].forEach((o2) => o2.classList.remove("selected"));
          b.classList.add("selected");
          picks[bIdx] = [oIdx];
        }
        maybeShowAnswerBtn();
      });
      block.appendChild(b);
    });
    blanksEl.appendChild(block);
  });

  function maybeShowAnswerBtn() {
    if (picks.every((p) => p && p.length) && !area.querySelector(".btn-primary")) {
      const btn = document.createElement("button");
      btn.className = "btn-primary";
      btn.style.marginTop = "4px";
      btn.textContent = "Ответить";
      btn.addEventListener("click", doGrade);
      area.querySelector(".slip").appendChild(btn);
    }
  }

  function doGrade() {
    let allOk = true;
    const blocks = blanksEl.querySelectorAll(".axis-block");
    blocks.forEach((block, bIdx) => {
      const correctSet = new Set(q.blanks[bIdx].map((o, i) => (o.correct ? i : -1)).filter((i) => i >= 0));
      const pickedSet = new Set(picks[bIdx]);
      const ok = correctSet.size === pickedSet.size && [...correctSet].every((i) => pickedSet.has(i));
      if (!ok) allOk = false;
      [...block.querySelectorAll(".axis-opt")].forEach((b, oIdx) => {
        b.disabled = true;
        if (correctSet.has(oIdx)) b.classList.add("correct");
        else if (pickedSet.has(oIdx)) b.classList.add("incorrect");
      });
    });
    grade("test", q.id, allOk);
    area.querySelector(".btn-primary").remove();
    area.querySelector("#verdict").innerHTML =
      `<div class="verdict ${allOk ? "ok" : "no"}">${allOk ? "✓ Всё верно" : "✕ Есть ошибки"}</div>` + explanationHtml(q);
    addNextButton(area);
  }
}

function normalizeAnswer(s) {
  return String(s)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[.,;:()«»"'!?]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function renderFillBlankSimpleCard(area, q) {
  area.innerHTML = `
    <div class="slip">
      ${slipHeader("Вставьте пропущенное", "test", q.id)}
      <div class="slip-question">${formatQuestionText(q.question).replace(/____/g, '<span class="blank-slot">____</span>')}</div>
      <input type="text" class="fill-input" id="fill-in" placeholder="Впишите ответ" autocomplete="off" autocapitalize="off" />
      <div id="verdict"></div>
    </div>
  `;
  wireFavButton(area);
  const input = area.querySelector("#fill-in");
  const answerBtn = document.createElement("button");
  answerBtn.className = "btn-primary";
  answerBtn.style.marginTop = "10px";
  answerBtn.textContent = "Ответить";
  answerBtn.disabled = true;
  answerBtn.addEventListener("click", doGrade);
  area.querySelector(".slip").appendChild(answerBtn);

  input.addEventListener("input", () => { answerBtn.disabled = input.value.trim().length === 0; });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !answerBtn.disabled) doGrade();
  });

  function doGrade() {
    const accepted = q.answer_text.split("/").map((s) => normalizeAnswer(s));
    const ok = accepted.includes(normalizeAnswer(input.value));
    grade("test", q.id, ok);
    input.disabled = true;
    answerBtn.remove();
    const v = area.querySelector("#verdict");
    v.innerHTML = `
      <div class="verdict ${ok ? "ok" : "no"}">${ok ? "✓ Правильно" : "✕ Неправильно"}</div>
      <div class="row-hint">Верный ответ: <b>${escapeHtml(q.answer_text.replace(/\//g, " / "))}</b></div>
    ` + explanationHtml(q);
    addNextButton(area);
  }
}

function renderFlashcardTestCard(area, q) {
  area.innerHTML = `
    <div class="slip">
      ${slipHeader(KIND_LABEL[q.type] || "Вопрос", "test", q.id)}
      <div class="slip-question" id="q-body">${renderFlashcardBody(q.raw, false)}</div>
    </div>
  `;
  wireFavButton(area);
  const revealBtn = document.createElement("button");
  revealBtn.className = "btn-primary";
  revealBtn.textContent = "Показать ответ";
  revealBtn.addEventListener("click", () => {
    area.querySelector("#q-body").innerHTML = renderFlashcardBody(q.raw, true);
    revealBtn.remove();
    addKnowButtons(area, "test", q.id);
  });
  area.querySelector(".slip").appendChild(revealBtn);
}

function addKnowButtons(area, kind, id) {
  const wrap = document.createElement("div");
  wrap.className = "btn-ghost-pair";
  wrap.innerHTML = `<button class="btn-know">✓ Знал(а)</button><button class="btn-dont">✕ Не знал(а)</button>`;
  area.querySelector(".slip").appendChild(wrap);
  wrap.querySelector(".btn-know").addEventListener("click", () => { grade(kind, id, true); wrap.remove(); addNextButton(area); });
  wrap.querySelector(".btn-dont").addEventListener("click", () => { grade(kind, id, false); wrap.remove(); addNextButton(area); });
}

// ---------------------------------------------------------------------
// RECIPE CARD
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// LEARN MODE (view questions/recipes with answers shown, no self-check)
// ---------------------------------------------------------------------

function addLearnNextButton(area) {
  const btn = document.createElement("button");
  btn.className = "btn-primary";
  btn.style.marginTop = "14px";
  btn.textContent = "Далее →";
  btn.addEventListener("click", () => { session.pos++; renderCurrent(); });
  area.querySelector(".slip").appendChild(btn);
}

function renderTestLearnCard(area, q) {
  let bodyHtml = "";
  if (q.type === "choice") {
    bodyHtml = `<div class="options">` + q.options.map((o, i) => `
      <div class="opt ${o.correct ? "correct" : ""}" style="cursor:default;">
        <span class="opt-label">${OPTION_LABELS[i] || i + 1}</span><span>${escapeHtml(o.text)}</span>
      </div>`).join("") + `</div>`;
  } else if (q.type === "matching" || q.type === "table") {
    const legend = q.categories.map((c, i) => `<span class="legend-chip"><span class="legend-num">${i + 1}</span>${escapeHtml(c)}</span>`).join("");
    const rows = q.items.map((item, i) => {
      const correctNames = q.answer[i].map((idx) => `${idx + 1}. ${escapeHtml(q.categories[idx])}`).join(", ");
      return `
      <div class="match-row row-ok">
        <div class="match-item">${escapeHtml(item)}</div>
        <div class="row-hint">Верно: <b>${correctNames}</b></div>
      </div>`;
    }).join("");
    bodyHtml = `<div class="legend">${legend}</div><div class="match-list">${rows}</div>`;
  } else if (q.type === "characterize") {
    bodyHtml = q.axes.map((axis) => `
      <div class="axis-block">
        <div class="axis-label">${escapeHtml(axis.label)}</div>
        ${axis.options.map((opt, oi) => `
          <div class="opt axis-opt ${oi === axis.correct ? "correct" : ""}" style="cursor:default;"><span>${escapeHtml(opt)}</span></div>
        `).join("")}
      </div>`).join("");
  } else if (q.type === "fill_blank" && q.blanks) {
    bodyHtml = q.blanks.map((options, bIdx) => `
      <div class="axis-block">
        <div class="axis-label">Пропуск ${bIdx + 1}</div>
        ${options.map((opt) => `
          <div class="opt axis-opt ${opt.correct ? "correct" : ""}" style="cursor:default;"><span>${escapeHtml(opt.text)}</span></div>
        `).join("")}
      </div>`).join("");
  } else if (q.type === "fill_blank_simple") {
    bodyHtml = `<div class="row-hint" style="margin-top:14px;font-size:15px;">Ответ: <b>${escapeHtml(q.answer_text.replace(/\//g, " / "))}</b></div>`;
  } else {
    bodyHtml = `<div class="slip-question">${renderFlashcardBody(q.raw, true)}</div>`;
  }

  area.innerHTML = `
    <div class="slip">
      ${slipHeader("👁 Просмотр", "test", q.id)}
      ${q.question ? `<div class="slip-question">${formatQuestionText(q.question)}</div>` : ""}
      ${bodyHtml}
      ${explanationHtml(q)}
    </div>
  `;
  wireFavButton(area);
  addLearnNextButton(area);
}

function renderRecipeLearnCard(area, r) {
  area.innerHTML = `
    <div class="slip">
      ${slipHeader("👁 Просмотр рецепта", "recipe", r.id)}
      <div class="slip-question"><b>${escapeHtml(r.name)}</b></div>
      <div class="rx-block">${escapeHtml(r.raw)}</div>
    </div>
  `;
  wireFavButton(area);
  addLearnNextButton(area);
}

function renderRecipeCard(area, r) {
  area.innerHTML = `
    <div class="slip">
      ${slipHeader("Напиши рецепт", "recipe", r.id)}
      <div class="slip-question"><b>${escapeHtml(r.name)}</b></div>
      <textarea class="rx-input" id="rx-in" placeholder="Rp.: ...&#10;D.t.d.: № ...&#10;S. ..."></textarea>
      <div id="rx-result"></div>
    </div>
  `;
  wireFavButton(area);
  const checkBtn = document.createElement("button");
  checkBtn.className = "btn-primary";
  checkBtn.style.marginTop = "6px";
  checkBtn.textContent = "Проверить";
  checkBtn.addEventListener("click", doCheck);
  area.querySelector(".slip").appendChild(checkBtn);

  function doCheck() {
    const userText = area.querySelector("#rx-in").value;
    const { percent, parts } = compareRecipe(userText, r);
    const ok = percent >= 80;
    grade("recipe", r.id, ok);

    const cls = percent >= 80 ? "ok" : percent >= 40 ? "partial" : "missing";
    const iconFor = (status) => (status === "ok" ? "✅" : status === "partial" ? "⚠️" : "❌");
    const partsHtml = parts.map((p) => `
      <div class="rx-part ${p.status}">
        <div class="p-label">${iconFor(p.status)} ${escapeHtml(p.label)}</div>
        <div class="p-expected">${escapeHtml(p.expected || "—")}</div>
      </div>
    `).join("");

    area.querySelector("#rx-result").innerHTML = `
      <div class="rx-score ${cls}">${percent}% совпадение</div>
      <div class="rx-parts">${partsHtml}</div>
      <div class="rx-block">${escapeHtml(r.raw)}</div>
    `;
    checkBtn.remove();
    area.querySelector("#rx-in").disabled = true;
    addNextButton(area);
  }
}

// ---------------------------------------------------------------------
// STATS
// ---------------------------------------------------------------------

function renderStats() {
  const st = Storage.getStats(ALL_TESTS.length, ALL_RECIPES.length);
  const per = Storage.getPeriodStats();

  const periodPct = (p) => (p.correct + p.wrong ? Math.round((100 * p.correct) / (p.correct + p.wrong)) : 0);
  const periodBlock = (label, p) => `
    <div class="stats-row"><span>${label}</span><b>${p.total} реш. · ${periodPct(p)}%</b></div>
  `;
  const periodsHtml = `
    <div class="stats-card">
      <h3>Активность</h3>
      ${periodBlock("Сегодня", per.today)}
      ${periodBlock("За неделю", per.week)}
      ${periodBlock("За всё время", per.all)}
    </div>
  `;

  const kindBlock = (label, s) => `
    <div class="stats-card">
      <h3>${label}</h3>
      <div class="stats-row"><span>Изучено</span><b>${s.seen} / ${s.total}</b></div>
      <div class="stats-row"><span>Правильных ответов</span><b>${s.correct}</b></div>
      <div class="stats-row"><span>Ошибок</span><b>${s.wrong}</b></div>
      <div class="stats-row"><span>Точность</span><b>${s.pct}%</b></div>
    </div>
  `;

  const bestExamHtml = per.bestExam
    ? `<div class="stats-card">
         <h3>Лучший экзамен</h3>
         <div class="stats-row"><span>Раздел</span><b>${per.bestExam.kind === "test" ? "Тесты" : "Рецепты"}</b></div>
         <div class="stats-row"><span>Результат</span><b>${per.bestExam.correct}/${per.bestExam.total} (${per.bestExam.pct}%)</b></div>
         <div class="stats-row"><span>Дата</span><b>${new Date(per.bestExam.date).toLocaleDateString("ru-RU")}</b></div>
       </div>`
    : "";
  const lastExamHtml = st.lastExam
    ? `<div class="stats-card">
         <h3>Последний экзамен</h3>
         <div class="stats-row"><span>Раздел</span><b>${st.lastExam.kind === "test" ? "Тесты" : "Рецепты"}</b></div>
         <div class="stats-row"><span>Результат</span><b>${st.lastExam.correct}/${st.lastExam.total} (${st.lastExam.pct}%)</b></div>
         <div class="stats-row"><span>Дата</span><b>${new Date(st.lastExam.date).toLocaleDateString("ru-RU")}</b></div>
       </div>`
    : "";

  const topicsHtml = renderTopicStatsHtml("test") + renderTopicStatsHtml("recipe");
  const calibrationHtml = renderCalibrationStatsHtml();

  document.getElementById("stats-body").innerHTML =
    periodsHtml + kindBlock("Тесты", st.tests) + kindBlock("Рецепты", st.recipes) + calibrationHtml + topicsHtml + lastExamHtml + bestExamHtml;
  wireTopicStatsClicks();
  showScreen("stats");
}

function renderCalibrationStatsHtml() {
  const c = Storage.getCalibrationStats();
  if (c.total < 5) return ""; // not enough self-reports yet to say anything meaningful
  return `
    <div class="stats-card">
      <h3>Калибровка уверенности</h3>
      <div class="stats-row"><span>😬 Уверен(а), но ошибся(лась)</span><b>${c.confidentWrong} раз(а) · ${c.overconfidencePct}% от уверенных ответов</b></div>
      <div class="stats-row"><span>🤔 Сомневался(лась), но ответил(а) верно</span><b>${c.unsureCorrect} раз(а) · ${c.underconfidencePct}% от неуверенных ответов</b></div>
      <div class="topic-row-sub" style="margin-top:6px;">
        ${c.overconfidencePct >= 25
          ? "Многовато случаев, когда уверенность подводит — стоит перепроверять себя даже в «очевидных» вопросах."
          : c.underconfidencePct >= 40
            ? "Часто сомневаешься зря — знаний обычно больше, чем кажется в моменте."
            : "Уверенность в целом совпадает с результатом — неплохая самооценка знаний."}
      </div>
    </div>
  `;
}

function renderTopicStatsHtml(kind) {
  const items = kind === "test" ? ALL_TESTS : ALL_RECIPES;
  const entries = Storage.getAllEntries(kind);
  const byTopic = {};
  for (const q of items) {
    const t = q.topic || "Общая фармакология";
    if (!byTopic[t]) byTopic[t] = { correct: 0, wrong: 0, seen: 0, total: 0, ids: [] };
    byTopic[t].total++;
    byTopic[t].ids.push(q.id);
    const e = entries[q.id];
    if (e && (e.correct || e.wrong)) {
      byTopic[t].seen++;
      byTopic[t].correct += e.correct;
      byTopic[t].wrong += e.wrong;
    }
  }
  const rows = Object.entries(byTopic)
    .filter(([, s]) => s.seen > 0)
    .map(([topic, s]) => {
      const attempts = s.correct + s.wrong;
      const pct = attempts ? Math.round((100 * s.correct) / attempts) : 0;
      const cls = pct >= 70 ? "good" : pct >= 40 ? "mid" : "low";
      return { topic, pct, seen: s.seen, total: s.total, cls, ids: s.ids };
    })
    .sort((a, b) => a.pct - b.pct);
  if (!rows.length) return "";
  const rowsHtml = rows.map((r) => `
    <div class="topic-row topic-row-tap" data-topic-kind="${kind}" data-topic-ids="${r.ids.join(",")}">
      <div class="topic-row-top"><span>${escapeHtml(r.topic)}</span><b class="topic-pct ${r.cls}">${r.pct}%</b></div>
      <div class="topic-bar"><span class="topic-bar-fill ${r.cls}" style="width:${r.pct}%"></span></div>
      <div class="topic-row-sub">${r.seen}/${r.total} ${kind === "test" ? "вопросов" : "рецептов"} пройдено · тапни, чтобы позаниматься</div>
    </div>
  `).join("");
  return `<div class="stats-card"><h3>По группам (${kind === "test" ? "тесты" : "рецепты"}) — от слабых к сильным</h3>${rowsHtml}</div>`;
}

function wireTopicStatsClicks() {
  document.querySelectorAll(".topic-row-tap").forEach((row) => {
    row.addEventListener("click", () => {
      const kind = row.dataset.topicKind;
      const ids = row.dataset.topicIds.split(",").map(Number);
      startSession(kind, "topic", ids);
    });
  });
}

// ---------------------------------------------------------------------
// SEARCH
// ---------------------------------------------------------------------

function questionKindMatchesFilter(q, filter) {
  if (filter === "all") return true;
  const groups = filter.split(",");
  return groups.some((g) => {
    if (g === "choice:single") return q.type === "choice" && !q.multi;
    if (g === "choice:multi") return q.type === "choice" && !!q.multi;
    if (g === "matching") return q.type === "matching";
    if (g === "table") return q.type === "table" || q.type === "characterize";
    if (g === "fill_blank") return q.type === "fill_blank" || q.type === "fill_blank_simple";
    return q.type === g;
  });
}

let searchFilter = "all";
let searchKind = "test";

function questionPreviewText(q) {
  if (q.question) return q.question;
  if (q.raw) return q.raw.replace(/\*\*/g, "").slice(0, 140);
  return "";
}

function recipePreviewText(r) {
  return `${r.name} — ${r.latin || ""} — ${r.sig || ""}`;
}

function renderSearchResults() {
  const term = document.getElementById("search-input").value.trim().toLowerCase();
  const resultsEl = document.getElementById("search-results");
  const numMatch = term.match(/^\d+$/);

  let hits;
  if (searchKind === "test") {
    hits = ALL_TESTS.filter((q) => {
      if (!questionKindMatchesFilter(q, searchFilter)) return false;
      if (!term) return true;
      if (numMatch && String(q.orig_num) === term) return true;
      return questionPreviewText(q).toLowerCase().includes(term);
    }).slice(0, 60);
  } else {
    hits = ALL_RECIPES.filter((r) => {
      if (!term) return true;
      return recipePreviewText(r).toLowerCase().includes(term);
    }).slice(0, 60);
  }

  if (!hits.length) {
    resultsEl.innerHTML = `<div class="search-empty">Ничего не найдено</div>`;
    return;
  }
  resultsEl.innerHTML = hits.map((item) => {
    const label = searchKind === "test"
      ? `<span class="n">#${item.orig_num ?? item.id}</span><span class="t">${escapeHtml(questionPreviewText(item).slice(0, 100))}</span>`
      : `<span class="t">${escapeHtml(recipePreviewText(item).slice(0, 100))}</span>`;
    return `<button class="search-hit" data-id="${item.id}">${label}</button>`;
  }).join("");
  resultsEl.querySelectorAll(".search-hit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      startSession(searchKind, "single", [id]);
    });
  });
}

function openSearch(kind) {
  searchKind = kind;
  document.getElementById("search-title").textContent = kind === "test" ? "Поиск по тестам" : "Поиск по рецептам";
  document.getElementById("filter-chips").classList.toggle("hidden", kind !== "test");
  document.getElementById("search-input").placeholder =
    kind === "test" ? "Номер или текст вопроса" : "Название препарата или рецепта";
  showScreen("search");
  document.getElementById("search-input").value = "";
  searchFilter = "all";
  document.querySelectorAll("#filter-chips .chip").forEach((c) => c.classList.toggle("active", c.dataset.filter === "all"));
  renderSearchResults();
  document.getElementById("search-input").focus();
}
document.getElementById("btn-open-search").addEventListener("click", () => openSearch(modesKind));
document.getElementById("search-input").addEventListener("input", renderSearchResults);
document.querySelectorAll("#filter-chips .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    searchFilter = chip.dataset.filter;
    document.querySelectorAll("#filter-chips .chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    renderSearchResults();
  });
});

// ---------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------

function initSettingsUI() {
  const s = Storage.getSettings();
  applyFontSize(s.fontSize);

  const nameInput = document.getElementById("setting-name");
  nameInput.value = s.userName || "";
  nameInput.addEventListener("change", () => {
    Storage.setSettings({ userName: nameInput.value.trim() });
  });

  const shuffleBtn = document.getElementById("setting-shuffle");
  shuffleBtn.setAttribute("aria-checked", s.shuffleAnswers ? "true" : "false");
  shuffleBtn.addEventListener("click", () => {
    const next = Storage.getSettings().shuffleAnswers ? false : true;
    Storage.setSettings({ shuffleAnswers: next });
    shuffleBtn.setAttribute("aria-checked", next ? "true" : "false");
  });

  const timerBtn = document.getElementById("setting-timer");
  timerBtn.setAttribute("aria-checked", s.examTimer ? "true" : "false");
  timerBtn.addEventListener("click", () => {
    const next = Storage.getSettings().examTimer ? false : true;
    Storage.setSettings({ examTimer: next });
    timerBtn.setAttribute("aria-checked", next ? "true" : "false");
  });

  const explainBtn = document.getElementById("setting-explanations");
  explainBtn.setAttribute("aria-checked", s.showExplanations ? "true" : "false");
  explainBtn.addEventListener("click", () => {
    const next = Storage.getSettings().showExplanations ? false : true;
    Storage.setSettings({ showExplanations: next });
    explainBtn.setAttribute("aria-checked", next ? "true" : "false");
  });

  const gamiBtn = document.getElementById("setting-gamification");
  gamiBtn.setAttribute("aria-checked", s.gamification !== false ? "true" : "false");
  gamiBtn.addEventListener("click", () => {
    const next = Storage.getSettings().gamification !== false ? false : true;
    Storage.setSettings({ gamification: next });
    gamiBtn.setAttribute("aria-checked", next ? "true" : "false");
  });

  const mnemoBtn = document.getElementById("setting-mnemonics");
  mnemoBtn.setAttribute("aria-checked", s.mnemonics !== false ? "true" : "false");
  mnemoBtn.addEventListener("click", () => {
    const next = Storage.getSettings().mnemonics !== false ? false : true;
    Storage.setSettings({ mnemonics: next });
    mnemoBtn.setAttribute("aria-checked", next ? "true" : "false");
  });

  const confBtn = document.getElementById("setting-confidence");
  confBtn.setAttribute("aria-checked", s.confidence !== false ? "true" : "false");
  confBtn.addEventListener("click", () => {
    const next = Storage.getSettings().confidence !== false ? false : true;
    Storage.setSettings({ confidence: next });
    confBtn.setAttribute("aria-checked", next ? "true" : "false");
  });

  const breaksBtn = document.getElementById("setting-breaks");
  breaksBtn.setAttribute("aria-checked", s.breakReminders !== false ? "true" : "false");
  breaksBtn.addEventListener("click", () => {
    const next = Storage.getSettings().breakReminders !== false ? false : true;
    Storage.setSettings({ breakReminders: next });
    breaksBtn.setAttribute("aria-checked", next ? "true" : "false");
  });

  document.querySelectorAll("#setting-fontsize [data-size]").forEach((btn) => {
    btn.addEventListener("click", () => {
      Storage.setSettings({ fontSize: btn.dataset.size });
      applyFontSize(btn.dataset.size);
    });
  });

  const goalSeg = document.getElementById("setting-dailygoal");
  if (goalSeg) {
    const applyGoalUI = (goal) => {
      [...goalSeg.children].forEach((b) => b.classList.toggle("active", Number(b.dataset.goal) === Number(goal)));
    };
    applyGoalUI(s.dailyGoal || 10);
    goalSeg.querySelectorAll("[data-goal]").forEach((btn) => {
      btn.addEventListener("click", () => {
        Storage.setSettings({ dailyGoal: Number(btn.dataset.goal) });
        applyGoalUI(btn.dataset.goal);
      });
    });
  }

  const matchStyleSeg = document.getElementById("setting-matchstyle");
  if (matchStyleSeg) {
    const applyMatchStyleUI = (style) => {
      [...matchStyleSeg.children].forEach((b) => b.classList.toggle("active", b.dataset.style === style));
    };
    applyMatchStyleUI(s.matchingStyle || "cards");
    matchStyleSeg.querySelectorAll("[data-style]").forEach((btn) => {
      btn.addEventListener("click", () => {
        Storage.setSettings({ matchingStyle: btn.dataset.style });
        applyMatchStyleUI(btn.dataset.style);
      });
    });
  }
}
initSettingsUI();

document.getElementById("btn-reset").addEventListener("click", () => {
  if (confirm("Точно сбросить весь прогресс, ошибки, избранное и статистику?")) {
    Storage.resetAll();
    applyFontSize("medium");
    renderHome();
  }
});

// ---------------------------------------------------------------------

loadData()
  .then(renderHome)
  .then(handleStartParam)
  .catch((e) => {
    document.getElementById("app").innerHTML =
      `<p style="padding:40px;text-align:center;color:#dc2626;">Не удалось загрузить данные: ${escapeHtml(e.message || String(e))}</p>`;
    console.error(e);
  });

/**
 * Deep-link from the bot's reminder push: "Открыть тренажёр" in the reminder
 * message points at `${MINIAPP_URL}?start=sprint`, so opening the Mini App
 * from that button drops straight into a 5-minute sprint — zero extra taps.
 */
function handleStartParam() {
  const params = new URLSearchParams(location.search);
  const start = params.get("start");
  if (start === "sprint") {
    const dueTest = Storage.getDueIds("test", allIds("test")).length;
    const dueRecipe = Storage.getDueIds("recipe", allIds("recipe")).length;
    const kind = dueTest === dueRecipe ? (Math.random() < 0.5 ? "test" : "recipe") : (dueTest > dueRecipe ? "test" : "recipe");
    startSession(kind, "sprint");
  }
}
