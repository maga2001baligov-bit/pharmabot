// storage.js — all persistence for the study app lives here.
// Nothing else in the app should touch localStorage directly.

const KEY = "pharma_progress_v3";
const REVIEW_INTERVALS_DAYS = [1, 3, 7, 14, 30];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const MAX_SESSIONS = 8;

function emptyState() {
  return {
    tests: {},     // id -> { correct, wrong, favorite, box, nextReview, error }
    recipes: {},   // id -> same shape
    history: [],   // { date, kind, mode, total, correct, wrong, pct }
    settings: {
      shuffleAnswers: false,
      examTimer: false,
      fontSize: "medium",
      userName: "",
      showExplanations: true, // toggle for the 💡 explanation box
      matchingStyle: "cards", // "cards" | "list" — how matching/table questions render
      gamification: true, // toggle for ranks/XP/streak/achievements on Home
    },
    sessions: [],  // [{ id, kind, mode, queue, pos, correct, wrong, startedAt, updatedAt }]
    theme: null,   // "light" | "dark" | null (null = not yet chosen)
    achievementsUnlocked: [], // string ids of achievements already shown to the user
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
    b[id] = { correct: 0, wrong: 0, favorite: false, box: 0, nextReview: null, error: false };
  }
  return b[id];
}

export const Storage = {
  todayISO,

  getEntry(kind, id) {
    const state = load();
    return { ...entryFor(state, kind, id) };
  },

  /** Record a result, update the error list and the spaced-repetition schedule. */
  recordResult(kind, id, wasCorrect) {
    const state = load();
    const e = entryFor(state, kind, id);
    if (wasCorrect) {
      e.correct += 1;
      e.error = false;
      e.box = Math.min(e.box + 1, REVIEW_INTERVALS_DAYS.length - 1);
      e.nextReview = addDaysISO(REVIEW_INTERVALS_DAYS[e.box]);
    } else {
      e.wrong += 1;
      e.error = true;
      e.box = 0;
      e.nextReview = todayISO();
    }
    save(state);
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
