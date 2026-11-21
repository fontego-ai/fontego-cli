// A workspace's tags are written one way, whoever writes them, and its icon is one of a closed list.

import { describe, expect, test } from "bun:test";
import { iconsFor, isNoIcon, isWorkspaceIcon, WORKSPACE_ICON_NAMES, WORKSPACE_ICONS } from "../src/icons.ts";
import { MAX_TAG_LENGTH, MAX_TAGS, normalizeTag, normalizeTags } from "../src/tags.ts";

const tag = (t: string) => {
  const n = normalizeTag(t);
  return "tag" in n ? n.tag : `problem: ${n.problem}`;
};

describe("normalizeTag", () => {
  test("one spelling: lowercase words joined by single dashes", () => {
    expect(tag("Clients")).toBe("clients");
    expect(tag("  CLIENTS ")).toBe("clients");
    expect(tag("Q4 planning")).toBe("q4-planning");
    expect(tag("q4_planning")).toBe("q4-planning");
    expect(tag("--q4 -- planning--")).toBe("q4-planning");
    expect(tag("tab\tand\nline")).toBe("tab-and-line");
  });

  test("any language, accents kept; composed and decomposed letters are the same tag", () => {
    expect(tag("Facturación")).toBe("facturación");
    expect(tag("Año 2026")).toBe("año-2026");
    expect(tag("Ano 2026")).toBe("ano-2026");
    expect(tag("日本")).toBe("日本");
    expect(tag("Ελλάδα")).toBe("ελλάδα");
    expect(tag("café")).toBe(tag("café"));
  });

  test("nothing that would need escaping in a path, a query or a list", () => {
    for (const bad of ["a/b", "a,b", "#legal", "c++", "r&d", "v1.2", "a?b", "50%", "x:y", "emoji 🙂"]) {
      expect(tag(bad)).toStartWith("problem:");
    }
    expect(tag("   ")).toBe("problem: a tag needs a letter or a digit");
    expect(tag("---")).toBe("problem: a tag needs a letter or a digit");
  });

  test("at most MAX_TAG_LENGTH characters, counted as characters, not bytes", () => {
    expect(tag("a".repeat(MAX_TAG_LENGTH))).toBe("a".repeat(MAX_TAG_LENGTH));
    expect(tag("a".repeat(MAX_TAG_LENGTH + 1))).toStartWith("problem:");
    expect(tag("ñ".repeat(MAX_TAG_LENGTH))).toBe("ñ".repeat(MAX_TAG_LENGTH));
  });
});

// No Zod here: core's tests also run in fontego-app, whose web bundle in the same process loses Zod's path through the
// core link. TagList, the schema around normalizeTags, is checked through the API in the server's tests.
describe("normalizeTags", () => {
  const tags = (v: string | string[]) => {
    const r = normalizeTags(v);
    return "tags" in r ? r.tags : `problem: ${r.problem}`;
  };

  test("a list or text split by commas or lines; repeats go, the order stays", () => {
    expect(tags(["Sales", "legal", "sales"])).toEqual(["sales", "legal"]);
    expect(tags("Sales, legal,\nQ4 planning, , SALES")).toEqual(["sales", "legal", "q4-planning"]);
    expect(tags("")).toEqual([]);
    expect(tags([])).toEqual([]);
  });

  test("one bad tag fails the whole list, saying which", () => {
    expect(tags("legal, a/b")).toBe(`problem: "a/b" can't be a tag: use letters, digits and dashes`);
  });

  test(`at most ${MAX_TAGS}, counted after repeats go`, () => {
    const many = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`);
    expect(tags([...many, "T0"])).toHaveLength(MAX_TAGS);
    expect(tags([...many, "one-more"])).toBe(`problem: a workspace takes at most ${MAX_TAGS} tags, and these are ${MAX_TAGS + 1}`);
  });
});

describe("the icons", () => {
  test("about forty, each named once, in lowercase and dashes, with what it suits", () => {
    expect(WORKSPACE_ICONS.length).toBeGreaterThanOrEqual(36);
    expect(new Set(WORKSPACE_ICON_NAMES).size).toBe(WORKSPACE_ICONS.length);
    for (const i of WORKSPACE_ICONS) {
      expect(i.name).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(i.themes.split(", ").length).toBeGreaterThanOrEqual(2);
    }
  });

  test("names only: a topic isn't an icon, but finds the icons that suit it", () => {
    expect(isWorkspaceIcon("scales")).toBe(true);
    expect(isWorkspaceIcon("legal")).toBe(false);
    expect(isWorkspaceIcon("Scales")).toBe(false);
    expect(isWorkspaceIcon(null)).toBe(false);
    expect(iconsFor("legal")).toEqual(["scales"]);
    expect(iconsFor("Invoice")).toEqual(["receipt"]);
    expect(iconsFor("support")[0]).toBe("lifebuoy");
    expect(iconsFor("x")).toEqual([]);
    expect(iconsFor("nothing-like-this")).toEqual([]);
  });

  test("no icon: nothing, empty or none", () => {
    for (const v of [null, undefined, "", "  ", "none", "None"]) expect(isNoIcon(v)).toBe(true);
    expect(isNoIcon("scales")).toBe(false);
  });
});
