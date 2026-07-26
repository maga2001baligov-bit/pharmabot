(function () {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); }

  const OPTION_LABELS = ["А", "Б", "В", "Г", "Д", "Е", "Ж", "З"];
  const KIND_LABEL = {
    matching: "Соответствие",
    fill_blank: "Вставьте слова",
    table: "Таблица",
    flashcard: "Задание",
  };

  let ALL_TESTS = [];
  let ALL_RECIPES = [];

  let session = null; // { kind: 'test'|'recipe', queue: [...], pos, correct, wrong, mode, selected:Set, revealed }

  const screens = {
    home: document.getElementById("screen-home"),
    session: document.getElementById("screen-session"),
    result: document.getElementById("screen-result"),
  };

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.add("hidden"));
    screens[name].classList.remove("hidden");
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function renderFlashcardBody(raw, revealed) {
    const boldRe = /\*\*(.+?)\*\*/g;
    let out = "";
    let last = 0;
    let m;
    while ((m = boldRe.exec(raw)) !== null) {
      out += escapeHtml(raw.slice(last, m.index));
      out += revealed
        ? `<b>${escapeHtml(m[1])}</b>`
        : `<span class="blank">···</span>`;
      last = boldRe.lastIndex;
    }
    out += escapeHtml(raw.slice(last));
    return out;
  }

  async function loadData() {
    const [testsRes, recipesRes] = await Promise.all([
      fetch("data/tests.json"),
      fetch("data/recipes.json"),
    ]);
    ALL_TESTS = await testsRes.json();
    ALL_RECIPES = await recipesRes.json();
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function sample(arr, n) {
    return shuffle(arr).slice(0, Math.min(n, arr.length));
  }

  // ---------------- session lifecycle ----------------

  function startMode(mode) {
    if (mode === "train_test") {
      session = { kind: "test", mode, queue: shuffle(ALL_TESTS.map((q) => q.id)), pos: 0, correct: 0, wrong: 0 };
    } else if (mode === "exam_test") {
      session = { kind: "test", mode, queue: sample(ALL_TESTS.map((q) => q.id), 40), pos: 0, correct: 0, wrong: 0 };
    } else if (mode === "train_recipe") {
      session = { kind: "recipe", mode, queue: shuffle(ALL_RECIPES.map((r) => r.id)), pos: 0, correct: 0, wrong: 0 };
    } else if (mode === "exam_recipe") {
      session = { kind: "recipe", mode, queue: sample(ALL_RECIPES.map((r) => r.id), 20), pos: 0, correct: 0, wrong: 0 };
    }
    document.getElementById("session-label").textContent =
      session.kind === "test" ? "тесты" : "рецепты";
    showScreen("session");
    renderCurrent();
  }

  function finishSession() {
    const total = session.correct + session.wrong;
    const pct = total ? Math.round((100 * session.correct) / total) : 0;
    document.getElementById("result-text").textContent =
      `Пройдено: ${total}\nВерно: ${session.correct}  ·  Неверно: ${session.wrong}\nТочность: ${pct}%`;
    showScreen("result");
  }

  function updateCounter() {
    document.getElementById("session-counter").textContent =
      `${session.pos + 1} / ${session.queue.length}`;
  }

  function renderCurrent() {
    if (session.pos >= session.queue.length) {
      finishSession();
      return;
    }
    updateCounter();
    const area = document.getElementById("card-area");
    if (session.kind === "test") {
      const q = ALL_TESTS.find((t) => t.id === session.queue[session.pos]);
      renderTestCard(area, q);
    } else {
      const r = ALL_RECIPES.find((x) => x.id === session.queue[session.pos]);
      renderRecipeCard(area, r);
    }
  }

  // ---------------- test rendering ----------------

  function renderTestCard(area, q) {
    if (q.type === "choice") {
      renderChoiceCard(area, q);
    } else if (q.type === "matching" || q.type === "table") {
      renderMatchingCard(area, q);
    } else if (q.type === "characterize") {
      renderCharacterizeCard(area, q);
    } else if (q.type === "fill_blank" && q.blanks) {
      renderFillBlankCard(area, q);
    } else {
      renderFlashcardTestCard(area, q);
    }
  }

  function renderChoiceCard(area, q) {
    const selected = new Set();
    area.innerHTML = `
      <div class="slip">
        <div class="slip-kicker">Вопрос с вариантами</div>
        <div class="slip-question">${escapeHtml(q.question)}</div>
        <div class="options" id="opts"></div>
        <div id="verdict"></div>
      </div>
    `;
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
          selected.clear();
          selected.add(i);
          grade();
        }
      });
      optsEl.appendChild(btn);
    });

    if (q.multi) {
      const submitBtn = document.createElement("button");
      submitBtn.className = "btn-primary";
      submitBtn.style.marginTop = "14px";
      submitBtn.textContent = "Готово";
      submitBtn.addEventListener("click", grade);
      area.querySelector(".slip").appendChild(submitBtn);
    }

    function grade() {
      const correctIdx = new Set(q.options.map((o, i) => (o.correct ? i : -1)).filter((i) => i >= 0));
      const ok = correctIdx.size === selected.size && [...correctIdx].every((i) => selected.has(i));
      [...optsEl.children].forEach((btn, i) => {
        btn.disabled = true;
        if (correctIdx.has(i)) btn.classList.add("correct");
        else if (selected.has(i)) btn.classList.add("incorrect");
      });
      const v = area.querySelector("#verdict");
      v.innerHTML = `<div class="verdict ${ok ? "ok" : "no"}">${ok ? "✓ Верно" : "✕ Неверно"}</div>`;
      if (ok) session.correct++; else session.wrong++;
      addNextButton(area);
    }
  }

  const NUM_LABELS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];

  function renderMatchingCard(area, q) {
    const picks = new Array(q.items.length).fill(null);
    let graded = false;

    area.innerHTML = `
      <div class="slip">
        <div class="slip-kicker">${q.type === "matching" ? "Соответствие" : "Классификация"}</div>
        <div class="slip-question">${escapeHtml(q.question)}</div>
        <div class="legend" id="legend"></div>
        <div class="match-list" id="match-list"></div>
        <div id="verdict"></div>
      </div>
    `;
    const legend = area.querySelector("#legend");
    q.categories.forEach((c, i) => {
      const chip = document.createElement("div");
      chip.className = "legend-chip";
      chip.innerHTML = `<span class="legend-num">${NUM_LABELS[i] || i + 1}</span>${escapeHtml(c)}`;
      legend.appendChild(chip);
    });

    const list = area.querySelector("#match-list");
    q.items.forEach((itemText, itemIdx) => {
      const row = document.createElement("div");
      row.className = "match-row";
      row.innerHTML = `<div class="match-item">${escapeHtml(itemText)}</div><div class="match-picks"></div>`;
      const picksEl = row.querySelector(".match-picks");
      q.categories.forEach((c, catIdx) => {
        const b = document.createElement("button");
        b.className = "pick-btn";
        b.textContent = NUM_LABELS[catIdx] || catIdx + 1;
        b.addEventListener("click", () => {
          if (graded) return;
          picks[itemIdx] = catIdx;
          [...picksEl.children].forEach((c2) => c2.classList.remove("picked"));
          b.classList.add("picked");
          maybeShowCheck();
        });
        picksEl.appendChild(b);
      });
      list.appendChild(row);
    });

    function maybeShowCheck() {
      if (picks.every((p) => p !== null) && !area.querySelector(".btn-primary")) {
        const btn = document.createElement("button");
        btn.className = "btn-primary";
        btn.style.marginTop = "14px";
        btn.textContent = "Проверить";
        btn.addEventListener("click", grade);
        area.querySelector(".slip").appendChild(btn);
      }
    }

    function grade() {
      graded = true;
      const rows = list.querySelectorAll(".match-row");
      let allOk = true;
      rows.forEach((row, i) => {
        const ok = picks[i] === q.answer[i];
        if (!ok) allOk = false;
        row.classList.add(ok ? "row-ok" : "row-no");
        [...row.querySelectorAll(".pick-btn")].forEach((b) => (b.disabled = true));
        if (!ok) {
          const hint = document.createElement("div");
          hint.className = "row-hint";
          hint.textContent = `Верно: ${q.categories[q.answer[i]]}`;
          row.appendChild(hint);
        }
      });
      if (allOk) session.correct++; else session.wrong++;
      area.querySelector(".btn-primary").remove();
      const v = area.querySelector("#verdict");
      v.innerHTML = `<div class="verdict ${allOk ? "ok" : "no"}">${allOk ? "✓ Всё верно" : "✕ Есть ошибки"}</div>`;
      addNextButton(area);
    }
  }

  function renderCharacterizeCard(area, q) {
    let graded = false;
    area.innerHTML = `
      <div class="slip">
        <div class="slip-kicker">Охарактеризуйте</div>
        <div class="slip-question">${escapeHtml(q.question)}</div>
        <div id="axes"></div>
        <div id="verdict"></div>
      </div>
    `;
    const axesEl = area.querySelector("#axes");
    const picks = new Array(q.axes.length).fill(null);

    q.axes.forEach((axis, axisIdx) => {
      const block = document.createElement("div");
      block.className = "axis-block";
      block.innerHTML = `<div class="axis-label">${escapeHtml(axis.label)}</div>`;
      axis.options.forEach((opt, optIdx) => {
        const b = document.createElement("button");
        b.className = "opt axis-opt";
        b.innerHTML = `<span class="opt-label">${OPTION_LABELS[optIdx] || optIdx + 1}</span><span>${escapeHtml(opt)}</span>`;
        b.addEventListener("click", () => {
          if (graded) return;
          picks[axisIdx] = optIdx;
          [...block.querySelectorAll(".axis-opt")].forEach((o) => o.classList.remove("selected"));
          b.classList.add("selected");
          maybeShowCheck();
        });
        block.appendChild(b);
      });
      axesEl.appendChild(block);
    });

    function maybeShowCheck() {
      if (picks.every((p) => p !== null) && !area.querySelector(".btn-primary")) {
        const btn = document.createElement("button");
        btn.className = "btn-primary";
        btn.style.marginTop = "4px";
        btn.textContent = "Проверить";
        btn.addEventListener("click", grade);
        area.querySelector(".slip").appendChild(btn);
      }
    }

    function grade() {
      graded = true;
      let allOk = true;
      const blocks = axesEl.querySelectorAll(".axis-block");
      blocks.forEach((block, i) => {
        const ok = picks[i] === q.axes[i].correct;
        if (!ok) allOk = false;
        [...block.querySelectorAll(".axis-opt")].forEach((b, oi) => {
          b.disabled = true;
          if (oi === q.axes[i].correct) b.classList.add("correct");
          else if (oi === picks[i]) b.classList.add("incorrect");
        });
      });
      if (allOk) session.correct++; else session.wrong++;
      area.querySelector(".btn-primary").remove();
      const v = area.querySelector("#verdict");
      v.innerHTML = `<div class="verdict ${allOk ? "ok" : "no"}">${allOk ? "✓ Всё верно" : "✕ Есть ошибки"}</div>`;
      addNextButton(area);
    }
  }

  function renderFillBlankCard(area, q) {
    let graded = false;
    const picks = new Array(q.blanks.length).fill(null);
    area.innerHTML = `
      <div class="slip">
        <div class="slip-kicker">Вставьте пропущенное</div>
        <div class="slip-question">${escapeHtml(q.question)}</div>
        <div id="blanks"></div>
        <div id="verdict"></div>
      </div>
    `;
    const blanksEl = area.querySelector("#blanks");
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
          if (graded) return;
          if (isMulti) {
            b.classList.toggle("selected");
            if (chosen.has(oIdx)) chosen.delete(oIdx); else chosen.add(oIdx);
            picks[bIdx] = [...chosen];
          } else {
            [...block.querySelectorAll(".axis-opt")].forEach((o) => o.classList.remove("selected"));
            b.classList.add("selected");
            picks[bIdx] = [oIdx];
          }
          maybeShowCheck();
        });
        block.appendChild(b);
      });
      blanksEl.appendChild(block);
    });

    function maybeShowCheck() {
      if (picks.every((p) => p && p.length) && !area.querySelector(".btn-primary")) {
        const btn = document.createElement("button");
        btn.className = "btn-primary";
        btn.style.marginTop = "4px";
        btn.textContent = "Проверить";
        btn.addEventListener("click", grade);
        area.querySelector(".slip").appendChild(btn);
      }
    }

    function grade() {
      graded = true;
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
      if (allOk) session.correct++; else session.wrong++;
      area.querySelector(".btn-primary").remove();
      const v = area.querySelector("#verdict");
      v.innerHTML = `<div class="verdict ${allOk ? "ok" : "no"}">${allOk ? "✓ Всё верно" : "✕ Есть ошибки"}</div>`;
      addNextButton(area);
    }
  }

  function renderFlashcardTestCard(area, q) {
    area.innerHTML = `
      <div class="slip">
        <div class="slip-kicker">${KIND_LABEL[q.type] || "Задание"}</div>
        <div class="slip-question" id="q-body">${renderFlashcardBody(q.raw, false)}</div>
      </div>
    `;
    const revealBtn = document.createElement("button");
    revealBtn.className = "btn-primary";
    revealBtn.style.marginTop = "0";
    revealBtn.textContent = "Показать ответ";
    revealBtn.addEventListener("click", () => {
      area.querySelector("#q-body").innerHTML = renderFlashcardBody(q.raw, true);
      revealBtn.remove();
      addKnowButtons(area, "test", q.id);
    });
    area.appendChild(revealBtn);
  }

  // ---------------- recipe rendering ----------------

  function renderRecipeCard(area, r) {
    area.innerHTML = `
      <div class="slip">
        <div class="slip-kicker">Напиши рецепт на препарат</div>
        <div class="slip-question"><b>${escapeHtml(r.name)}</b></div>
        <div id="rx" class="rx-block hidden"></div>
      </div>
    `;
    const revealBtn = document.createElement("button");
    revealBtn.className = "btn-primary";
    revealBtn.textContent = "Показать ответ";
    revealBtn.addEventListener("click", () => {
      const rx = area.querySelector("#rx");
      rx.textContent = r.text;
      rx.classList.remove("hidden");
      revealBtn.remove();
      addKnowButtons(area, "recipe", r.id);
    });
    area.appendChild(revealBtn);
  }

  // ---------------- shared UI helpers ----------------

  function addKnowButtons(area, kind, itemId) {
    const wrap = document.createElement("div");
    wrap.className = "btn-ghost-pair";
    wrap.innerHTML = `
      <button class="btn-know">✓ Знал(а)</button>
      <button class="btn-dont">✕ Не знал(а)</button>
    `;
    area.appendChild(wrap);
    wrap.querySelector(".btn-know").addEventListener("click", () => {
      session.correct++;
      advance();
    });
    wrap.querySelector(".btn-dont").addEventListener("click", () => {
      session.wrong++;
      advance();
    });
  }

  function addNextButton(area) {
    const btn = document.createElement("button");
    btn.className = "btn-primary";
    btn.style.marginTop = "14px";
    btn.textContent = "Далее →";
    btn.addEventListener("click", advance);
    area.querySelector(".slip").appendChild(btn);
  }

  function advance() {
    session.pos++;
    renderCurrent();
  }

  // ---------------- wiring ----------------

  document.querySelectorAll(".ticket").forEach((btn) => {
    btn.addEventListener("click", () => startMode(btn.dataset.mode));
  });

  document.getElementById("btn-back").addEventListener("click", () => {
    session = null;
    showScreen("home");
  });

  document.getElementById("btn-again").addEventListener("click", () => {
    session = null;
    showScreen("home");
  });

  loadData().catch((e) => {
    document.getElementById("app").innerHTML =
      '<p style="padding:40px;text-align:center;color:#7a3b46;">Не удалось загрузить данные. Попробуй перезайти.</p>';
    console.error(e);
  });
})();
