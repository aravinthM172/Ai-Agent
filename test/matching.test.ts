import { describe, expect, it } from "vitest";
import {
  canonicalSkill,
  profileHasSkill,
  scoreMatch,
  yearsOfExperience,
  type JobRequirements
} from "../src/lib/matching";

const PROFILE =
  "Backend engineer with 4 years of experience. Skills: TypeScript, Node.js, Python, PostgreSQL, REST APIs, Docker, AWS (Lambda, S3). Built payment microservices handling 2M requests/day. No Kubernetes or Go experience.";

describe("canonicalSkill", () => {
  it("maps aliases to one name", () => {
    expect(canonicalSkill("Golang")).toBe("go");
    expect(canonicalSkill("K8s")).toBe("kubernetes");
    expect(canonicalSkill("Postgres")).toBe("postgresql");
    expect(canonicalSkill("NodeJS")).toBe("node.js");
  });

  it("leaves unknown skills as lowercase", () => {
    expect(canonicalSkill("  Rust ")).toBe("rust");
  });
});

describe("profileHasSkill", () => {
  it("finds skills and their aliases", () => {
    expect(profileHasSkill(PROFILE, "TypeScript")).toBe(true);
    expect(profileHasSkill(PROFILE, "Postgres")).toBe(true);
    expect(profileHasSkill(PROFILE, "nodejs")).toBe(true);
  });

  it("does not count negated skills", () => {
    // "No Kubernetes or Go experience."
    expect(profileHasSkill(PROFILE, "Kubernetes")).toBe(false);
    expect(profileHasSkill(PROFILE, "Golang")).toBe(false);
  });

  it("matches whole words only", () => {
    // "Go" must not match inside "Google" or "going".
    expect(profileHasSkill("Worked at Google, going strong", "Go")).toBe(false);
    // "Java" must not match "JavaScript".
    expect(profileHasSkill("5 years of JavaScript", "Java")).toBe(false);
  });

  it("keeps symbols that are part of a skill name", () => {
    expect(profileHasSkill("Expert in C++ and C#", "C++")).toBe(true);
    expect(profileHasSkill("Expert in C++ and C#", "C#")).toBe(true);
    expect(profileHasSkill("Expert in C", "C++")).toBe(false);
  });

  it("accepts either side of an 'or' requirement", () => {
    expect(profileHasSkill(PROFILE, "Go or TypeScript")).toBe(true);
    expect(profileHasSkill(PROFILE, "Rust or Go")).toBe(false);
  });
});

describe("yearsOfExperience", () => {
  it("reads the largest years figure", () => {
    expect(yearsOfExperience(PROFILE)).toBe(4);
    expect(yearsOfExperience("2 yrs at A, then 5+ years at B")).toBe(5);
    expect(yearsOfExperience("recent graduate")).toBeNull();
  });
});

describe("scoreMatch", () => {
  const job: JobRequirements = {
    requiredSkills: ["Go or TypeScript", "PostgreSQL", "Kubernetes", "AWS"],
    niceToHaveSkills: ["Docker", "Terraform"],
    minYearsExperience: 5,
    seniority: "senior",
    summary: "Senior backend engineer for payments."
  };

  it("scores matched vs missing skills with an experience penalty", () => {
    const result = scoreMatch(job, PROFILE);
    expect(result.matchedSkills).toEqual([
      "Go or TypeScript",
      "PostgreSQL",
      "AWS"
    ]);
    expect(result.missingSkills).toEqual(["Kubernetes"]);
    expect(result.matchedNiceToHave).toEqual(["Docker"]);
    expect(result.profileYears).toBe(4);
    expect(result.experienceGapYears).toBe(1);
    // 3/4 skills = 75, minus 10 for one missing year
    expect(result.score).toBe(65);
  });

  it("is deterministic", () => {
    expect(scoreMatch(job, PROFILE)).toEqual(scoreMatch(job, PROFILE));
  });

  it("ignores duplicate requirements", () => {
    const result = scoreMatch(
      { ...job, requiredSkills: ["AWS", "aws", "Amazon Web Services"] },
      PROFILE
    );
    expect(result.matchedSkills).toEqual(["AWS"]);
    expect(result.score).toBe(90); // 100 - 10 (one year short)
  });

  it("caps the experience penalty at 30 points", () => {
    const result = scoreMatch(
      { ...job, requiredSkills: ["AWS"], minYearsExperience: 15 },
      PROFILE
    );
    expect(result.score).toBe(70);
  });

  it("gives a neutral score when the job lists no skills", () => {
    const result = scoreMatch(
      { ...job, requiredSkills: [], minYearsExperience: null },
      PROFILE
    );
    expect(result.score).toBe(50);
  });
});
