// A workspace's tags: free text its admins write, kept one way so the same tag is never spelled twice. The rule is
// here, with no dependencies, so the server (through TagList in schemas.ts), the CLI and the web app (which shows how
// a tag will be kept while it is typed) all write tags the same.

/** How many tags a workspace can have, and how long each can be (in characters). */
export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 32;

/** A tag as it is kept: words of letters (any language), marks and digits, joined by single dashes. */
const TAG = /^[\p{L}\p{M}\p{Nd}]+(?:-[\p{L}\p{M}\p{Nd}]+)*$/u;

/**
 * A tag the way it is kept, whoever wrote it: lowercase words joined by dashes, so "Clients", "clients" and "CLIENTS "
 * are one tag and "Q4 planning" is q4-planning. Spaces, underscores and runs of dashes become one dash; accents stay
 * (they change words). Whatever else is left (a comma, a slash, a #) makes it no tag, and `problem` says why.
 */
export function normalizeTag(text: string): { tag: string } | { problem: string } {
  const tag = text
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (!tag) return { problem: "a tag needs a letter or a digit" };
  if (!TAG.test(tag)) return { problem: `${JSON.stringify(text.trim())} can't be a tag: use letters, digits and dashes` };
  if ([...tag].length > MAX_TAG_LENGTH) return { problem: `${JSON.stringify(text.trim())} is too long for a tag: use at most ${MAX_TAG_LENGTH} characters` };
  return { tag };
}

/**
 * A whole list of tags, from a list or from text split by commas or new lines (empty text is no tags): each written
 * the way it is kept, repeats gone, the order kept, and at most MAX_TAGS. The first problem when one can't be a tag.
 */
export function normalizeTags(value: readonly string[] | string): { tags: string[] } | { problem: string } {
  const items = typeof value === "string" ? value.split(/[,\n]/).filter((t) => t.trim() !== "") : value;
  const tags: string[] = [];
  for (const item of items) {
    const n = normalizeTag(item);
    if ("problem" in n) return n;
    if (!tags.includes(n.tag)) tags.push(n.tag);
  }
  if (tags.length > MAX_TAGS) return { problem: `a workspace takes at most ${MAX_TAGS} tags, and these are ${tags.length}` };
  return { tags };
}
