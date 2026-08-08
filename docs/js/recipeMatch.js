// recipeMatch.js — strict, criterion-based comparison of a user's written
// recipe attempt against the canonical recipe stored in the database.
//
// Mirrors how a professor actually grades a Rp.: exact match required for
// the hard facts (Latin drug name, dose, concentration, volume, dosage
// form, D.t.d. number) — only the indication (S.) tolerates paraphrasing.

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(s) {
  return (s || "")
    .replace(/ё/g, "е")
    .replace(/(\d),(\d)/g, "$1.$2") // 0,5 -> 0.5
    .toLowerCase();
}

function normWords(s) {
  return normalizeText(s)
    .replace(/[«»"'`]/g, "")
    .replace(/[.,;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function statusFromScore(score) {
  if (score >= 1) return "ok";
  if (score >= 0.4) return "partial";
  return "missing";
}

/** All expected words must appear as exact whole tokens somewhere in the user's text. */
function exactWordCoverage(expectedWords, userWordSet) {
  if (!expectedWords.length) return 1;
  let hit = 0;
  for (const w of expectedWords) if (userWordSet.has(w)) hit += 1;
  return hit / expectedWords.length;
}

/** Fuzzy token coverage for the free-text indication (paraphrasing allowed). */
function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return 1 - dp[n] / Math.max(m, n);
}
function fuzzyCoverage(expectedWords, userWords) {
  if (!expectedWords.length) return 1;
  let hit = 0;
  for (const w of expectedWords) {
    const found = userWords.some((u) => similarity(w, u) >= 0.8 || u.includes(w) || w.includes(u));
    if (found) hit += 1;
  }
  return hit / expectedWords.length;
}

/** Does the exact numeric value appear as a standalone number in the text? */
function hasExactNumber(normText, value) {
  if (value == null) return null; // criterion not applicable to this recipe
  const v = escapeRegex(String(value));
  const re = new RegExp(`(^|[^0-9.])${v}(?![0-9])`);
  return re.test(normText);
}

/**
 * Compare a free-text recipe attempt against the structured recipe record.
 * recipe: { latin, dtdCount, form, sig, crit: { drugName, concentration, volume, doseValue, doseUnit } }
 * returns { percent, parts: [{label, status, score, expected}] }
 */
export function compareRecipe(userText, recipe) {
  const normText = normalizeText(userText);
  const userWords = normWords(userText);
  const userWordSet = new Set(userWords);
  const crit = recipe.crit || {};
  const parts = [];

  // 1) Latin drug name — exact word match required, no typo tolerance
  const nameWords = normWords(crit.drugName || recipe.latin);
  const nameScore = exactWordCoverage(nameWords, userWordSet);
  parts.push({
    key: "name", label: "Название (латынь)", expected: crit.drugName || recipe.latin,
    score: nameScore, status: statusFromScore(nameScore),
  });

  // 2) Dose / concentration / volume — exact numeric match
  if (crit.doseValue != null) {
    const ok = hasExactNumber(normText, crit.doseValue);
    parts.push({
      key: "dose", label: "Доза", expected: `${crit.doseValue} ${crit.doseUnit || ""}`.trim(),
      score: ok ? 1 : 0, status: ok ? "ok" : "missing",
    });
  }
  if (crit.concentration != null) {
    const ok = hasExactNumber(normText, crit.concentration);
    parts.push({
      key: "conc", label: "Концентрация", expected: `${crit.concentration}%`,
      score: ok ? 1 : 0, status: ok ? "ok" : "missing",
    });
  }
  if (crit.volume != null) {
    const ok = hasExactNumber(normText, crit.volume);
    parts.push({
      key: "vol", label: "Объём", expected: `${crit.volume} ml`,
      score: ok ? 1 : 0, status: ok ? "ok" : "missing",
    });
  }

  // 3) D.t.d. number — exact
  if (recipe.dtdCount) {
    const ok = hasExactNumber(normText, recipe.dtdCount);
    parts.push({
      key: "dtd", label: "Количество (№)", expected: `№ ${recipe.dtdCount}`,
      score: ok ? 1 : 0, status: ok ? "ok" : "missing",
    });
  }

  // 4) Dosage form — exact word match
  if (recipe.form) {
    const formWords = normWords(recipe.form);
    const formScore = exactWordCoverage(formWords, userWordSet);
    parts.push({
      key: "form", label: "Форма выпуска", expected: recipe.form,
      score: formScore, status: statusFromScore(formScore),
    });
  }

  // 5) Signature / indication — paraphrasing allowed, fuzzy match
  const sigWords = normWords(recipe.sig);
  const sigScore = fuzzyCoverage(sigWords, userWords);
  parts.push({
    key: "sig", label: "Показание (S.)", expected: recipe.sig,
    score: sigScore, status: statusFromScore(sigScore),
  });

  const weights = { name: 0.3, dose: 0.15, conc: 0.1, vol: 0.1, dtd: 0.1, form: 0.1, sig: 0.15 };
  let weightedSum = 0, weightTotal = 0;
  for (const p of parts) {
    const w = weights[p.key] ?? 0.1;
    weightedSum += p.score * w;
    weightTotal += w;
  }
  const percent = Math.round(100 * (weightTotal ? weightedSum / weightTotal : 0));

  return { percent, parts };
}
