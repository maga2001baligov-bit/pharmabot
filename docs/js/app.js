import { Storage } from "./storage.js";
import { compareRecipe } from "./recipeMatch.js";

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

document.getElementById("theme-toggle").addEventListener("click", () => {
  const next = Storage.getTheme() === "dark" ? "light" : "dark";
  Storage.setTheme(next);
  applyTheme(next);
});

// Live-sync with Telegram's theme if the user switches it while the app is open,
// but only if they haven't manually overridden the toggle themselves this session.
let userOverrodeTheme = false;
document.getElementById("theme-toggle").addEventListener("click", () => { userOverrodeTheme = true; });
if (tg && typeof tg.onEvent === "function") {
  tg.onEvent("themeChanged", () => {
    if (userOverrodeTheme) return;
    const next = tg.colorScheme === "dark" ? "dark" : "light";
    Storage.setTheme(next);
    applyTheme(next);
  });
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
let session = null;

const screens = {};
["home", "modes", "errors", "session", "result", "stats", "settings"].forEach((n) => {
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
  const [t, r] = await Promise.all([fetch("data/tests.json"), fetch("data/recipes.json")]);
  ALL_TESTS = await t.json();
  ALL_RECIPES = await r.json();
}

function allIds(kind) { return (kind === "test" ? ALL_TESTS : ALL_RECIPES).map((x) => x.id); }
function byId(kind, id) { return (kind === "test" ? ALL_TESTS : ALL_RECIPES).find((x) => x.id === id); }

// ---------------------------------------------------------------------
// HOME
// ---------------------------------------------------------------------

function renderHome() {
  const today = Storage.getTodayCounts();
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

  showScreen("home");
}

document.querySelectorAll("[data-nav]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const nav = btn.dataset.nav;
    if (nav === "tests") openModes("test");
    else if (nav === "recipes") openModes("recipe");
    else if (nav === "stats") renderStats();
    else if (nav === "errors") renderErrorsHub();
    else if (nav === "settings") showScreen("settings");
  });
});

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const dest = btn.dataset.back;
    if (dest === "home") renderHome();
    else if (dest === "modes") openModes(session ? session.kind : "test");
  });
});

// ---------------------------------------------------------------------
// MODE SELECT
// ---------------------------------------------------------------------

function openModes(kind) {
  document.getElementById("modes-title").textContent = kind === "test" ? "Тесты" : "Рецепты";
  const total = allIds(kind).length;
  const errors = Storage.getErrorIds(kind).length;
  const favs = Storage.getFavoriteIds(kind).length;
  const due = Storage.getDueIds(kind, allIds(kind)).length;

  const modes = [
    { key: "all", t: "Все", d: "Пройти весь банк по порядку", n: total },
    { key: "exam", t: "Экзамен", d: `Билет: ${EXAM_SIZE[kind]} случайных`, n: Math.min(EXAM_SIZE[kind], total) },
    { key: "random", t: "Случайные", d: "Вразброс, без ограничений", n: total },
    { key: "errors", t: "Ошибки", d: "Только то, где были неверные ответы", n: errors, empty: errors === 0 },
    { key: "favorites", t: "Избранное", d: "Отмеченные звёздочкой", n: favs, empty: favs === 0 },
    { key: "review", t: "Повторение", d: "Пора повторить по графику", n: due, empty: due === 0 },
  ];

  const list = document.getElementById("mode-list");
  list.innerHTML = "";
  modes.forEach((m) => {
    const btn = document.createElement("button");
    btn.className = "mode-btn";
    btn.disabled = !!m.empty;
    btn.innerHTML = `<span><span class="t">${m.t}</span><br><span class="d">${m.d}</span></span><span class="n">${m.n}</span>`;
    if (!m.empty) btn.addEventListener("click", () => startSession(kind, m.key));
    list.appendChild(btn);
  });

  showScreen("modes");
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

function buildQueue(kind, mode) {
  const ids = allIds(kind);
  switch (mode) {
    case "all": return ids.slice();
    case "random": return shuffle(ids);
    case "exam": return sample(ids, EXAM_SIZE[kind]);
    case "errors": return shuffle(Storage.getErrorIds(kind));
    case "favorites": return shuffle(Storage.getFavoriteIds(kind));
    case "review": return shuffle(Storage.getDueIds(kind, ids));
    default: return shuffle(ids);
  }
}

function startSession(kind, mode) {
  const queue = buildQueue(kind, mode);
  session = { kind, mode, queue, pos: 0, correct: 0, wrong: 0 };
  document.getElementById("session-label").textContent = kind === "test" ? "тесты" : "рецепты";
  showScreen("session");
  renderCurrent();
}

function updateCounter() {
  document.getElementById("session-counter").textContent = `${session.pos + 1} / ${session.queue.length}`;
}

function renderCurrent() {
  if (session.pos >= session.queue.length) return finishSession();
  updateCounter();
  const area = document.getElementById("card-area");
  const id = session.queue[session.pos];
  if (session.kind === "test") renderTestCard(area, byId("test", id));
  else renderRecipeCard(area, byId("recipe", id));
}

function finishSession() {
  const total = session.correct + session.wrong;
  const pct = total ? Math.round((100 * session.correct) / total) : 0;
  Storage.recordSession(session.kind, session.mode, total, session.correct, session.wrong);
  document.getElementById("result-mark").textContent = pct >= 70 ? "✓" : "";
  document.getElementById("result-text").textContent =
    `Пройдено: ${total}\nВерно: ${session.correct}  ·  Неверно: ${session.wrong}\nТочность: ${pct}%`;
  const reviewBtn = document.getElementById("btn-review-errors");
  if (session.wrong > 0) {
    reviewBtn.classList.remove("hidden");
    reviewBtn.onclick = () => startSession(session.kind, "errors");
  } else {
    reviewBtn.classList.add("hidden");
  }
  showScreen("result");
}
document.getElementById("btn-again").addEventListener("click", () => { session = null; renderHome(); });

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
  });
}

function addNextButton(area) {
  const btn = document.createElement("button");
  btn.className = "btn-primary";
  btn.style.marginTop = "14px";
  btn.textContent = "Следующий вопрос →";
  btn.addEventListener("click", () => { session.pos++; renderCurrent(); });
  area.querySelector(".slip").appendChild(btn);
}

function grade(kind, id, ok) {
  Storage.recordResult(kind, id, ok);
  if (ok) session.correct++; else session.wrong++;
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
  return `<div class="slip-top"><span class="slip-kicker">${kicker}</span>${favToggleHtml(kind, id)}</div>`;
}

function renderChoiceCard(area, q) {
  const selected = new Set();
  area.innerHTML = `
    <div class="slip">
      ${slipHeader("Вопрос с вариантами", "test", q.id)}
      <div class="slip-question">${escapeHtml(q.question)}</div>
      <div class="options" id="opts"></div>
      <div id="verdict"></div>
    </div>
  `;
  wireFavButton(area);
  const optsEl = area.querySelector("#opts");
  q.options.forEach((opt, i) => {
    const btn = document.createElement("button");
    btn.className = "opt";
    btn.innerHTML = `<span class="opt-label">${OPTION_LABELS[i] || i + 1}</span><span>${escapeHtml(opt.text)}</span>`;
    btn.addEventListener("click", () => {
      if (q.multi) {
        btn.classList.toggle("selected");
        if (selected.has(i)) selected.delete(i); else selected.add(i);
      } else {
        [...optsEl.children].forEach((b) => b.classList.remove("selected"));
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
    const correctIdx = new Set(q.options.map((o, i) => (o.correct ? i : -1)).filter((i) => i >= 0));
    const ok = correctIdx.size === selected.size && [...correctIdx].every((i) => selected.has(i));
    [...optsEl.children].forEach((btn, i) => {
      btn.disabled = true;
      if (correctIdx.has(i)) btn.classList.add("correct");
      else if (selected.has(i)) btn.classList.add("incorrect");
    });
    grade("test", q.id, ok);
    const v = area.querySelector("#verdict");
    v.innerHTML = `<div class="verdict ${ok ? "ok" : "no"}">${ok ? "✓ Правильно" : "✕ Неправильно"}</div>`;
    answerBtn.remove();
    addNextButton(area);
  }
}

function renderMatchingCard(area, q) {
  area.innerHTML = `
    <div class="slip">
      ${slipHeader(q.type === "matching" ? "Соответствие" : "Классификация", "test", q.id)}
      <div class="slip-question">${escapeHtml(q.question)}</div>
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
  const picks = new Array(q.items.length).fill(null);
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
        picks[i] = catIdx;
        [...picksEl.children].forEach((x) => x.classList.remove("picked"));
        b.classList.add("picked");
        maybeShowAnswerBtn();
      });
      picksEl.appendChild(b);
    });
    rows.appendChild(row);
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
    [...rows.children].forEach((row, i) => {
      const ok = picks[i] === q.answer[i];
      if (!ok) allOk = false;
      row.classList.add(ok ? "row-ok" : "row-no");
      [...row.querySelectorAll(".pick-btn")].forEach((b) => (b.disabled = true));
      if (!ok) {
        row.innerHTML += `<div class="row-hint">Верно: <b>${q.answer[i] + 1}</b>. ${escapeHtml(q.categories[q.answer[i]])}</div>`;
      }
    });
    grade("test", q.id, allOk);
    area.querySelector(".btn-primary").remove();
    area.querySelector("#verdict").innerHTML =
      `<div class="verdict ${allOk ? "ok" : "no"}">${allOk ? "✓ Всё верно" : "✕ Есть ошибки"}</div>`;
    addNextButton(area);
  }
}

function renderCharacterizeCard(area, q) {
  area.innerHTML = `
    <div class="slip">
      ${slipHeader("Охарактеризуйте", "test", q.id)}
      <div class="slip-question">${escapeHtml(q.question)}</div>
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
      `<div class="verdict ${allOk ? "ok" : "no"}">${allOk ? "✓ Всё верно" : "✕ Есть ошибки"}</div>`;
    addNextButton(area);
  }
}

function renderFillBlankCard(area, q) {
  area.innerHTML = `
    <div class="slip">
      ${slipHeader("Вставьте пропущенное", "test", q.id)}
      <div class="slip-question">${escapeHtml(q.question)}</div>
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
      `<div class="verdict ${allOk ? "ok" : "no"}">${allOk ? "✓ Всё верно" : "✕ Есть ошибки"}</div>`;
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
      <div class="slip-question">${escapeHtml(q.question).replace(/____/g, '<span class="blank-slot">____</span>')}</div>
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
    `;
    addNextButton(area);
  }
}


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
  wrap.querySelector(".btn-know").addEventListener("click", () => { grade(kind, id, true); session.pos++; renderCurrent(); });
  wrap.querySelector(".btn-dont").addEventListener("click", () => { grade(kind, id, false); session.pos++; renderCurrent(); });
}

// ---------------------------------------------------------------------
// RECIPE CARD
// ---------------------------------------------------------------------

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
    const partsHtml = parts.map((p) => `
      <div class="rx-part ${p.status}">
        <div class="p-label">${escapeHtml(p.label)}</div>
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
  const kindBlock = (label, s) => `
    <div class="stats-card">
      <h3>${label}</h3>
      <div class="stats-row"><span>Изучено</span><b>${s.seen} / ${s.total}</b></div>
      <div class="stats-row"><span>Правильных ответов</span><b>${s.correct}</b></div>
      <div class="stats-row"><span>Ошибок</span><b>${s.wrong}</b></div>
      <div class="stats-row"><span>Точность</span><b>${s.pct}%</b></div>
    </div>
  `;
  const lastExamHtml = st.lastExam
    ? `<div class="stats-card">
         <h3>Последний экзамен</h3>
         <div class="stats-row"><span>Раздел</span><b>${st.lastExam.kind === "test" ? "Тесты" : "Рецепты"}</b></div>
         <div class="stats-row"><span>Результат</span><b>${st.lastExam.correct}/${st.lastExam.total} (${st.lastExam.pct}%)</b></div>
         <div class="stats-row"><span>Дата</span><b>${new Date(st.lastExam.date).toLocaleDateString("ru-RU")}</b></div>
       </div>`
    : "";
  document.getElementById("stats-body").innerHTML =
    kindBlock("Тесты", st.tests) + kindBlock("Рецепты", st.recipes) + lastExamHtml;
  showScreen("stats");
}

// ---------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------

document.getElementById("btn-reset").addEventListener("click", () => {
  if (confirm("Точно сбросить весь прогресс, ошибки, избранное и статистику?")) {
    Storage.resetAll();
    renderHome();
  }
});

// ---------------------------------------------------------------------

loadData()
  .then(renderHome)
  .catch((e) => {
    document.getElementById("app").innerHTML =
      '<p style="padding:40px;text-align:center;color:#dc2626;">Не удалось загрузить данные. Попробуй перезайти.</p>';
    console.error(e);
  });
