/** Prefer definition (then mechanic) when describing a concept. */
const DESCRIPTION_TYPE_RANK: Record<string, number> = {
  definition: 0,
  mechanic: 1,
  heuristic: 2,
  market_norm: 3,
  negotiation_move: 4,
  warning: 5,
  anecdote: 6,
};

export type ClaimForDescription = {
  statement: string;
  claimType: string;
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * True when the statement looks like it is about this concept — not a linked
 * neighbor term (e.g. "participating preferred" under Liquidation Preference).
 */
export function claimDefinesConcept(
  statement: string,
  conceptLabel: string,
): boolean {
  const stmt = normalize(statement);
  const label = normalize(conceptLabel);
  if (!stmt || !label) return false;
  if (stmt.includes(label)) return true;

  const tokens = label.split(" ").filter((t) => t.length > 3);
  if (tokens.length === 0) return false;
  const hits = tokens.filter((t) => stmt.includes(t)).length;
  // Require all meaningful tokens so "liquidation preference" does not match
  // a claim that only mentions "liquidation" in a different sense.
  return hits >= tokens.length;
}

/** Definitional: "X are …", "X is …", "X refers to …" (allows plural -s). */
export function isDefinitionalStatement(
  statement: string,
  conceptLabel: string,
): boolean {
  const stmt = normalize(statement);
  const label = normalize(conceptLabel);
  if (!stmt.includes(label)) return false;
  const labelPat = label.replace(/\s+/g, "\\s+") + "s?";
  const re = new RegExp(
    `\\b${labelPat}\\s+(is|are|refers\\s+to|means|describes)\\b`,
  );
  return re.test(stmt);
}

/** Obligation / compliance note — poor one-liner material. */
export function isModalObligation(statement: string): boolean {
  const stmt = normalize(statement);
  return /\b(must|should|shall|may|need to|have to)\b/.test(stmt);
}

function descriptionScore(
  c: ClaimForDescription,
  conceptLabel: string,
): number {
  const typeRank = DESCRIPTION_TYPE_RANK[c.claimType] ?? 50;
  let score = typeRank * 100;
  if (isDefinitionalStatement(c.statement, conceptLabel)) score -= 40;
  if (isModalObligation(c.statement)) score += 35;
  // Mild preference for medium length (too short often incomplete)
  const len = c.statement.length;
  if (len < 60) score += 10;
  if (len > 280) score += 5;
  return score;
}

/** Statement used as the concept blurb — must be about this concept's label. */
export function pickConceptDescription(
  claims: ClaimForDescription[],
  conceptLabel?: string,
): string | null {
  if (!claims.length) return null;

  const label = conceptLabel?.trim() || "";
  const pool = label
    ? claims.filter((c) => claimDefinesConcept(c.statement, label))
    : claims;
  if (!pool.length) return null;

  let best: ClaimForDescription | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const c of pool) {
    const score = label ? descriptionScore(c, label) : DESCRIPTION_TYPE_RANK[c.claimType] ?? 50;
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best?.statement ?? null;
}

/** Normalize for duplicate detection between one-liner and claim cards. */
export function statementsMatch(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

/**
 * Concept-level favors chip only when a majority of claims agree on a
 * non-null favors value.
 */
export function consensusFavors(
  claims: { favors: string | null }[],
): string | null {
  if (!claims.length) return null;
  const counted = claims.filter((c) => c.favors && c.favors !== "not_applicable");
  if (counted.length * 2 <= claims.length) return null; // need majority with a value
  const tallies = new Map<string, number>();
  for (const c of counted) {
    tallies.set(c.favors!, (tallies.get(c.favors!) || 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of tallies) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  // Majority of all claims must agree
  if (!best || bestN * 2 <= claims.length) return null;
  return best;
}

export function claimTypeRank(claimType: string): number {
  return DESCRIPTION_TYPE_RANK[claimType] ?? 50;
}
