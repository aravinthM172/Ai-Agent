/**
 * Deterministic resume ↔ job matching.
 *
 * The LLM only *extracts* a job's requirements (see requirements.ts); the
 * score is computed here in plain code, so the same resume and job always
 * get the same score, and the logic is unit-testable. Asking the model for a
 * percentage directly gives a different number on every run.
 */

/** Common spellings of the same skill, mapped to one canonical name. */
const ALIASES: Record<string, string[]> = {
  javascript: ["javascript", "js", "ecmascript"],
  typescript: ["typescript", "ts"],
  "node.js": ["node.js", "nodejs", "node"],
  postgresql: ["postgresql", "postgres", "psql"],
  kubernetes: ["kubernetes", "k8s"],
  go: ["go", "golang"],
  python: ["python"],
  "c++": ["c++", "cpp"],
  "c#": ["c#", "csharp"],
  ".net": [".net", "dotnet"],
  aws: ["aws", "amazon web services"],
  gcp: ["gcp", "google cloud", "google cloud platform"],
  azure: ["azure", "microsoft azure"],
  "ci/cd": ["ci/cd", "cicd", "continuous integration"],
  react: ["react", "react.js", "reactjs"],
  "spring boot": ["spring boot", "springboot"],
  sql: ["sql"],
  "rest apis": ["rest apis", "rest api", "restful"],
  graphql: ["graphql"],
  docker: ["docker"],
  terraform: ["terraform"],
  "machine learning": ["machine learning", "ml"]
};

/** Canonical lowercase name for a skill ("Golang" → "go", "K8s" → "kubernetes"). */
export function canonicalSkill(skill: string): string {
  const s = skill.trim().toLowerCase();
  for (const [canonical, variants] of Object.entries(ALIASES)) {
    if (variants.includes(s)) return canonical;
  }
  return s;
}

const NEGATION = /\b(no|not|without|never|lacks?|lacking)\b/;

/**
 * True if `profile` mentions `skill` (or an alias of it) in a positive way.
 * "No Kubernetes or Go experience" does NOT count as having Kubernetes or Go.
 */
export function profileHasSkill(profile: string, skill: string): boolean {
  // "Go or TypeScript" / "Go / TypeScript": having either one counts.
  const alternatives = skill.split(/\s+or\s+|\s+\/\s+/i);
  if (alternatives.length > 1) {
    return alternatives.some((alt) => profileHasSkill(profile, alt));
  }
  const canonical = canonicalSkill(skill);
  const variants = ALIASES[canonical] ?? [canonical];
  // Split into clauses on sentence punctuation followed by whitespace, so
  // "Node.js" stays intact but "…AWS. No Go…" becomes two clauses.
  const clauses = profile.toLowerCase().split(/(?<=[.;!?])\s+|\n+/);
  return clauses.some((clause) =>
    variants.some((variant) => {
      const at = findWord(clause, variant);
      if (at < 0) return false;
      // A negation word before the skill in the same clause negates it.
      return !NEGATION.test(clause.slice(0, at));
    })
  );
}

/** Index of `word` in `text` as a whole word/phrase, or -1. */
function findWord(text: string, word: string): number {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|[^a-z0-9+#])${escaped}(?![a-z0-9+#])`).exec(
    text
  );
  return match ? match.index + match[1].length : -1;
}

/** Largest "N years" / "N+ yrs" figure in the text, or null. */
export function yearsOfExperience(text: string): number | null {
  const years = [...text.matchAll(/(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/gi)].map(
    (m) => Number(m[1])
  );
  return years.length ? Math.max(...years) : null;
}

export type JobRequirements = {
  requiredSkills: string[];
  niceToHaveSkills: string[];
  minYearsExperience: number | null;
  seniority: string | null;
  summary: string;
};

export type MatchResult = {
  /** 0–100: share of required skills the profile has, minus an experience penalty. */
  score: number;
  matchedSkills: string[];
  missingSkills: string[];
  matchedNiceToHave: string[];
  profileYears: number | null;
  /** Years short of the job's minimum, or 0. */
  experienceGapYears: number;
};

/** Scores a resume/profile against extracted job requirements. */
export function scoreMatch(
  requirements: JobRequirements,
  profile: string
): MatchResult {
  const required = dedupe(requirements.requiredSkills);
  const matchedSkills = required.filter((s) => profileHasSkill(profile, s));
  const missingSkills = required.filter((s) => !matchedSkills.includes(s));
  const matchedNiceToHave = dedupe(requirements.niceToHaveSkills).filter((s) =>
    profileHasSkill(profile, s)
  );

  const profileYears = yearsOfExperience(profile);
  const experienceGapYears =
    requirements.minYearsExperience != null && profileYears != null
      ? Math.max(0, requirements.minYearsExperience - profileYears)
      : 0;

  const skillScore = required.length
    ? (matchedSkills.length / required.length) * 100
    : 50; // no listed requirements: neutral score rather than a fake 100
  // Each missing year of required experience costs 10 points, capped at 30.
  const score = Math.round(
    Math.max(0, skillScore - Math.min(30, experienceGapYears * 10))
  );

  return {
    score,
    matchedSkills,
    missingSkills,
    matchedNiceToHave,
    profileYears,
    experienceGapYears
  };
}

function dedupe(skills: string[]) {
  const seen = new Set<string>();
  return skills.filter((s) => {
    const key = canonicalSkill(s);
    if (!s.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
