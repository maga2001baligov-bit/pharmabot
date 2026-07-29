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

function emptyState() {
  return {
    tests: {},     // id -> { correct, wrong, favorite, box, nextReview, error }
    recipes: {},   // id -> same shape
    history: [],   // { date, kind, mode, total, correct, wrong, pct }
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    return { ...emptyState(), ...parsed };
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

  resetAll() {
    save(emptyState());
  },
};
