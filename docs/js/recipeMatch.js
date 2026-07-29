// recipeMatch.js — fuzzy, structure-aware comparison of a user's written
// recipe attempt against the canonical recipe stored in the database.

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/(\d),(\d)/g, "$1.$2")   // 0,5 -> 0.5 (unify decimal separators)
    .replace(/[«»"'`]/g, "")
    .replace(/[-–—]/g, "-")
    .replace(/[^\p{L}\p{N}.\-/% ]+/gu, " ") // strip stray punctuation, keep meaningful chars
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s) {
  return normalize(s).split(" ").filter(Boolean);
}

/** Levenshtein similarity ratio in [0,1], 1 = identical. */
function similarity(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const dist = dp[n];
  return 1 - dist / Math.max(m, n);
}

/** Best-effort token overlap: how many of `needle`'s tokens appear
 * (exactly or fuzzily) somewhere in `haystack`. */
function tokenCoverage(needleTokens, haystackTokens) {
  if (!needleTokens.length) return 1;
  let hit = 0;
  for (const t of needleTokens) {
    const found = haystackTokens.some((h) => similarity(t, h) >= 0.8 || h.includes(t) || t.includes(h));
    if (found) hit += 1;
  }
  return hit / needleTokens.length;
}

function statusFromScore(score) {
  if (score >= 0.8) return "ok";
  if (score >= 0.4) return "partial";
  return "missing";
}

/**
 * Compare a free-text recipe attempt against the structured recipe record.
 * recipe: { latin, dtdCount, form, sig }
 * returns { percent, parts: [{label, status, score, expected}] }
 */
export function compareRecipe(userText, recipe) {
  const userTokens = tokenize(userText);

  const parts = [];

  // 1) Latin drug name + dose
  const latinTokens = tokenize(recipe.latin);
  const latinScore = tokenCoverage(latinTokens, userTokens);
  parts.push({
    key: "latin",
    label: "Название и доза",
    expected: recipe.latin,
    score: latinScore,
    status: statusFromScore(latinScore),
  });

  // 2) D.t.d. count + form
  if (recipe.dtdCount) {
    const dtdExpected = `${recipe.dtdCount} ${recipe.form || ""}`.trim();
    const userNormalized = normalize(userText);
    const numberPresent = new RegExp(`(^|\\D)${recipe.dtdCount}(\\D|$)`).test(userNormalized);
    const formScore = recipe.form ? tokenCoverage(tokenize(recipe.form), userTokens) : 1;
    const dtdScore = numberPresent ? Math.max(formScore, 0.6) : formScore * 0.3;
    parts.push({
      key: "dtd",
      label: "Количество и форма",
      expected: `№ ${dtdExpected}`,
      score: dtdScore,
      status: statusFromScore(dtdScore),
    });
  }

  // 3) Signature / indication
  const sigTokens = tokenize(recipe.sig);
  const sigScore = tokenCoverage(sigTokens, userTokens);
  parts.push({
    key: "sig",
    label: "Показание (S.)",
    expected: recipe.sig,
    score: sigScore,
    status: statusFromScore(sigScore),
  });

  const weights = { latin: 0.5, dtd: 0.2, sig: 0.3 };
  let weightedSum = 0, weightTotal = 0;
  for (const p of parts) {
    const w = weights[p.key] ?? 0.2;
    weightedSum += p.score * w;
    weightTotal += w;
  }
  const percent = Math.round(100 * (weightTotal ? weightedSum / weightTotal : 0));

  return { percent, parts };
}
