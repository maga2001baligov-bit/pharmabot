// storage.js — all persistence for the study app lives here.
// Nothing else in the app should touch localStorage directly.

const KEY = "pharma_progress_v3";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetweenISO(fromISO, toISO) {
  const a = new Date(fromISO + "T00:00:00");
  const b = new Date(toISO + "T00:00:00");
  return Math.round((b - a) / 86400000);
}

const MAX_SESSIONS = 8;

function emptyState() {
  return {
    tests: {},     // id -> { correct, wrong, favorite, box, nextReview, error }
    recipes: {},   // id -> same shape
    history: [],   // { date, kind, mode, total, correct, wrong, pct }
    settings: {
      shuffleAnswers: true,
      examTimer: false,
      fontSize: "medium",
      userName: "",
      showExplanations: true, // toggle for the 💡 explanation box
      matchingStyle: "cards", // "cards" | "list" — how matching/table questions render
      gamification: true, // toggle for ranks/XP/streak/achievements on Home
      mnemonics: true, // toggle for the personal-mnemonic box under each card
      confidence: true, // toggle for the post-answer "were you sure?" calibration prompt
      breakReminders: true, // toggle for the "you've been at this a while" nudge during long sessions
      dailyGoal: 10, // "visible today's goal" ring target — small and achievable on purpose
    },
    sessions: [],  // [{ id, kind, mode, queue, pos, correct, wrong, startedAt, updatedAt }]
    theme: null,   // "light" | "dark" | null (null = not yet chosen)
    achievementsUnlocked: [], // string ids of achievements already shown to the user
    calibration: [], // [{ date, kind, id, correct, confident }] — rolling log for the confidence-calibration stats
    bonusXP: 0, // accumulated "surprise bonus" XP from the variable-reward streak system
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    const state = { ...emptyState(), ...parsed };
    // migrate legacy single-session field into the sessions list, once
    if (parsed.activeSession && (!parsed.sessions || !parsed.sessions.length)) {
      const legacy = parsed.activeSession;
      if (legacy.pos < legacy.queue.length) {
        state.sessions = [{
          id: legacy.id || Date.now(),
          ...legacy,
          updatedAt: legacy.updatedAt || new Date().toISOString(),
        }];
      }
    }
    delete state.activeSession;
    return state;
  } catch (e) {
    console.error("Storage load failed, starting fresh", e);
    return emptyState();
  }
}

function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.error("Storage save failed", e);
  }
}

function bucket(state, kind) {
  return kind === "recipe" ? state.recipes : state.tests;
}

function entryFor(state, kind, id) {
  const b = bucket(state, kind);
  if (!b[id]) {
    b[id] = { correct: 0, wrong: 0, favorite: false, ease: 2.5, interval: 0, reps: 0, nextReview: null, error: false, mnemonic: "" };
  }
  return b[id];
}

export const Storage = {
  todayISO,

  getEntry(kind, id) {
    const state = load();
    return { ...entryFor(state, kind, id) };
  },

  /**
   * Record a result and reschedule with an FSRS-inspired algorithm
   * (stability/difficulty/retrievability model with a power-law forgetting
   * curve), replacing the earlier SM-2-style scheduler. This is a simplified,
   * self-tuned variant — not a byte-for-byte port of the reference FSRS
   * weights — chosen because it models forgetting more realistically than
   * SM-2's fixed 1→6→interval*ease ladder, especially for cards reviewed
   * very late or very early relative to their schedule.
   *
   * Backward compatible: existing entries only have the old SM-2 fields
   * (ease/reps/interval). On first call after the upgrade we derive a
   * starting stability/difficulty from those instead of resetting anyone's
   * progress to zero. e.interval/e.lastReviewed keep being written exactly
   * as before, so getMemoryStrength() and the memory-ring UI need no changes.
   */
  recordResult(kind, id, wasCorrect) {
    const state = load();
    const e = entryFor(state, kind, id);

    const today = todayISO();
    const elapsedDays = e.lastReviewed ? Math.max(0, daysBetweenISO(e.lastReviewed, today)) : 0;

    if (e.difficulty == null) {
      // Migrate from the old SM-2 ease factor (1.3 hard .. 2.5+ easy) onto an
      // FSRS-style difficulty scale (1 easy .. 10 hard) — inverse relationship.
      const oldEase = e.ease != null ? e.ease : 2.5;
      e.difficulty = Math.max(1, Math.min(10, 10 - (oldEase - 1.3) * (9 / 1.7)));
    }
    if (e.stability == null) {
      // Old interval (days) is a reasonable proxy for a starting stability.
      e.stability = Math.max(0.5, e.interval || 1);
    }

    // Retrievability just before this review, using FSRS's power forgetting
    // curve (falls off more slowly than exponential decay, matching how
    // human forgetting is actually shaped).
    const retrievability = elapsedDays > 0
      ? Math.pow(1 + elapsedDays / (9 * e.stability), -1)
      : 1;

    if (wasCorrect) {
      e.correct += 1;
      e.error = false;
      // Successful recall: stability grows more when the card was already
      // fading (low retrievability) and less when it was still fresh —
      // the "spacing effect".
      const growth = 1 + 0.9 * (1 - retrievability) * (1 / Math.sqrt(e.difficulty));
      e.stability = Math.max(0.5, e.stability * growth);
      e.difficulty = Math.max(1, e.difficulty - 0.15);
    } else {
      e.wrong += 1;
      e.error = true;
      // Lapse: stability drops sharply (classic FSRS behaviour) but not all
      // the way back to zero, and difficulty rises so it's treated as harder.
      e.stability = Math.max(0.5, e.stability * 0.35);
      e.difficulty = Math.min(10, e.difficulty + 1.2);
    }

    e.lastReviewed = today;
    e.interval = Math.max(1, Math.round(e.stability));
    e.nextReview = addDaysISO(e.interval);
    save(state);
  },

  /**
   * "Memory strength" 0–100 for the ring UI: how much of the interval between
   * the last review and the next scheduled one has already elapsed, inverted
   * (100 = just reviewed, 0 = due/overdue). Mirrors a forgetting-curve decay.
   */
  getMemoryStrength(kind, id) {
    const state = load();
    const e = bucket(state, kind)[id];
    if (!e || !e.lastReviewed || !e.interval) return null; // never graded yet
    const elapsed = daysBetweenISO(e.lastReviewed, todayISO());
    const pct = Math.round(100 * (1 - elapsed / e.interval));
    return Math.max(0, Math.min(100, pct));
  },

  toggleFavorite(kind, id) {
    const state = load();
    const e = entryFor(state, kind, id);
    e.favorite = !e.favorite;
    save(state);
    return e.favorite;
  },

  isFavorite(kind, id) {
    const state = load();
    return !!bucket(state, kind)[id]?.favorite;
  },

  getFavoriteIds(kind) {
    const state = load();
    const b = bucket(state, kind);
    return Object.keys(b).filter((id) => b[id].favorite).map(Number);
  },

  getMnemonic(kind, id) {
    const state = load();
    return bucket(state, kind)[id]?.mnemonic || "";
  },

  setMnemonic(kind, id, text) {
    const state = load();
    const e = entryFor(state, kind, id);
    e.mnemonic = (text || "").trim();
    save(state);
    return e.mnemonic;
  },

  getErrorIds(kind) {
    const state = load();
    const b = bucket(state, kind);
    return Object.keys(b).filter((id) => b[id].error).map(Number);
  },

  getDueIds(kind, allIds) {
    const state = load();
    const b = bucket(state, kind);
    const today = todayISO();
    return allIds.filter((id) => {
      const e = b[id];
      return e && e.nextReview && e.nextReview <= today;
    });
  },

  getSeenIds(kind) {
    const state = load();
    return Object.keys(bucket(state, kind)).map(Number);
  },

  getAllEntries(kind) {
    const state = load();
    return bucket(state, kind);
  },

  recordSession(kind, mode, total, correct, wrong) {
    const state = load();
    const pct = total ? Math.round((100 * correct) / total) : 0;
    state.history.push({ date: new Date().toISOString(), kind, mode, total, correct, wrong, pct });
    state.history = state.history.slice(-100); // keep it bounded
    save(state);
  },

  getStats(totalTests, totalRecipes) {
    const state = load();
    const summarize = (bucketObj, total) => {
      const ids = Object.keys(bucketObj);
      const seen = ids.length;
      const correct = ids.reduce((s, id) => s + bucketObj[id].correct, 0);
      const wrong = ids.reduce((s, id) => s + bucketObj[id].wrong, 0);
      const attempts = correct + wrong;
      return {
        seen,
        total,
        correct,
        wrong,
        pct: attempts ? Math.round((100 * correct) / attempts) : 0,
      };
    };
    const lastExam = [...state.history].reverse().find((h) => h.mode === "exam");
    return {
      tests: summarize(state.tests, totalTests),
      recipes: summarize(state.recipes, totalRecipes),
      lastExam: lastExam || null,
      historyCount: state.history.length,
    };
  },

  getTodayCounts() {
    const state = load();
    const today = todayISO();
    let correct = 0, wrong = 0;
    for (const h of state.history) {
      if (h.date.slice(0, 10) === today) {
        correct += h.correct;
        wrong += h.wrong;
      }
    }
    return { correct, wrong };
  },

  /** Aggregate solved-question counts for today / last 7 days / all time. */
  getPeriodStats() {
    const state = load();
    const today = todayISO();
    const weekAgo = addDaysISO(-7);
    const sum = (rows) => rows.reduce((acc, h) => ({
      correct: acc.correct + h.correct,
      wrong: acc.wrong + h.wrong,
      total: acc.total + h.total,
    }), { correct: 0, wrong: 0, total: 0 });
    const todayRows = state.history.filter((h) => h.date.slice(0, 10) === today);
    const weekRows = state.history.filter((h) => h.date.slice(0, 10) >= weekAgo);
    const allRows = state.history;
    const bestExam = state.history
      .filter((h) => h.mode === "exam")
      .reduce((best, h) => (!best || h.pct > best.pct ? h : best), null);
    return { today: sum(todayRows), week: sum(weekRows), all: sum(allRows), bestExam };
  },

  getSettings() {
    const state = load();
    return { ...emptyState().settings, ...state.settings };
  },

  setSettings(partial) {
    const state = load();
    state.settings = { ...emptyState().settings, ...state.settings, ...partial };
    save(state);
    return state.settings;
  },

  /** Upsert a session snapshot into the recent-sessions list (max MAX_SESSIONS, most recent first). */
  saveSession(sessionSnapshot) {
    const state = load();
    const withStamp = { ...sessionSnapshot, updatedAt: new Date().toISOString() };
    const idx = state.sessions.findIndex((s) => s.id === withStamp.id);
    if (idx >= 0) state.sessions[idx] = withStamp;
    else state.sessions.unshift(withStamp);
    state.sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    state.sessions = state.sessions.slice(0, MAX_SESSIONS);
    save(state);
  },

  /** Most recent unfinished session overall (for the home-screen "continue" card). */
  getLatestSession() {
    const state = load();
    return state.sessions[0] || null;
  },

  /** All saved sessions, optionally filtered by kind ("test" | "recipe"). */
  getSessions(kind) {
    const state = load();
    return kind ? state.sessions.filter((s) => s.kind === kind) : state.sessions.slice();
  },

  getSessionById(id) {
    const state = load();
    return state.sessions.find((s) => s.id === id) || null;
  },

  deleteSession(id) {
    const state = load();
    state.sessions = state.sessions.filter((s) => s.id !== id);
    save(state);
  },

  resetAll() {
    const theme = load().theme;
    const fresh = emptyState();
    fresh.theme = theme;
    save(fresh);
  },

  getTheme() {
    const state = load();
    return state.theme; // null | "light" | "dark"
  },

  setTheme(theme) {
    const state = load();
    state.theme = theme;
    save(state);
  },

  /** Full session-summary history (for streak calculation etc). */
  getHistory() {
    return load().history.slice();
  },

  /**
   * Log a post-answer confidence self-report for the calibration stats
   * ("уверен, но ошибся" / "не был уверен, но угадал верно").
   * `confident` is a plain boolean the person taps right after seeing the verdict.
   */
  recordConfidence(kind, id, wasCorrect, confident) {
    const state = load();
    if (!state.calibration) state.calibration = [];
    state.calibration.push({ date: new Date().toISOString(), kind, id, correct: !!wasCorrect, confident: !!confident });
    state.calibration = state.calibration.slice(-500); // keep it bounded
    save(state);
  },

  /** Aggregate the calibration log into the four confident×correct quadrants. */
  getCalibrationStats() {
    const rows = load().calibration || [];
    const q = { confidentCorrect: 0, confidentWrong: 0, unsureCorrect: 0, unsureWrong: 0 };
    for (const r of rows) {
      if (r.confident && r.correct) q.confidentCorrect++;
      else if (r.confident && !r.correct) q.confidentWrong++;
      else if (!r.confident && r.correct) q.unsureCorrect++;
      else q.unsureWrong++;
    }
    const total = rows.length;
    const confidentTotal = q.confidentCorrect + q.confidentWrong;
    const unsureTotal = q.unsureCorrect + q.unsureWrong;
    return {
      total,
      ...q,
      overconfidencePct: confidentTotal ? Math.round((100 * q.confidentWrong) / confidentTotal) : 0,
      underconfidencePct: unsureTotal ? Math.round((100 * q.unsureCorrect) / unsureTotal) : 0,
    };
  },

  /** Small unpredictable reward — a random amount added on top of the normal XP formula. */
  addBonusXP(amount) {
    const state = load();
    state.bonusXP = (state.bonusXP || 0) + amount;
    save(state);
    return state.bonusXP;
  },
  getBonusXP() {
    return load().bonusXP || 0;
  },

  getUnlockedAchievements() {
    return (load().achievementsUnlocked || []).slice();
  },

  /** Mark an achievement as shown/unlocked. Returns true if it was newly added. */
  unlockAchievement(id) {
    const state = load();
    if (!state.achievementsUnlocked) state.achievementsUnlocked = [];
    if (state.achievementsUnlocked.includes(id)) return false;
    state.achievementsUnlocked.push(id);
    save(state);
    return true;
  },
};
