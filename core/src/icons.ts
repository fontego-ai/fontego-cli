// The icons a workspace can have: a closed list, so every client knows each one. A workspace's admins choose one (or
// none) to tell it apart at a glance among many. Each is named by what it shows, not by a topic, because one picture
// suits several topics; its themes say which, for people searching the list and for agents choosing one.
//
// Only the names live here: the API checks them and the CLI lists them. The drawings belong to whoever draws them
// (the web app). Names are only ever added, never taken away or renamed: workspaces keep the one they have.

export const WORKSPACE_ICONS = [
  // Work
  { name: "briefcase", themes: "clients, business, work" },
  { name: "building", themes: "a company, an organization, an office" },
  { name: "store", themes: "shops, retail, stores" },
  { name: "cart", themes: "orders, purchases, e-commerce" },
  { name: "board", themes: "projects, boards, workflow" },
  { name: "checklist", themes: "tasks, to-dos, reviews" },
  { name: "calendar", themes: "planning, events, schedules" },
  { name: "flag", themes: "milestones, launches, goals" },
  { name: "target", themes: "goals, objectives, OKRs" },
  // Money
  { name: "banknote", themes: "finance, money, budgets" },
  { name: "receipt", themes: "invoices, billing, expenses" },
  { name: "chart-bars", themes: "reports, analytics, metrics" },
  { name: "chart-line", themes: "sales, growth, trends" },
  // Legal and safe
  { name: "scales", themes: "legal, contracts, compliance" },
  { name: "shield", themes: "security, risk, safety" },
  { name: "lock", themes: "private, confidential, secrets" },
  // Talking to people
  { name: "megaphone", themes: "marketing, announcements, communication" },
  { name: "chat", themes: "conversations, feedback, community" },
  { name: "envelope", themes: "mail, correspondence, newsletters" },
  { name: "lifebuoy", themes: "support, help, customer service" },
  // Written things
  { name: "book", themes: "documentation, knowledge, manuals" },
  { name: "document", themes: "documents, policies, specs" },
  { name: "archive", themes: "an archive, records, old work" },
  { name: "pencil", themes: "writing, content, drafts" },
  // People
  { name: "person", themes: "someone's own, personal, profiles" },
  { name: "people", themes: "people, teams, HR" },
  { name: "graduation", themes: "training, education, onboarding" },
  { name: "heart", themes: "health, wellbeing, care" },
  // Thinking
  { name: "flask", themes: "research, experiments, labs" },
  { name: "lightbulb", themes: "ideas, innovation, brainstorming" },
  { name: "compass", themes: "strategy, direction, exploring" },
  { name: "sparkle", themes: "AI, automation, assistants" },
  { name: "rocket", themes: "launches, products, startups" },
  // Making
  { name: "gear", themes: "operations, processes, settings" },
  { name: "wrench", themes: "maintenance, tools, IT" },
  { name: "code", themes: "software, engineering, development" },
  { name: "database", themes: "data, databases, datasets" },
  { name: "palette", themes: "design, brand, creative work" },
  { name: "camera", themes: "media, photos, video" },
  // Moving things, and outside
  { name: "box", themes: "products, packages, inventory" },
  { name: "truck", themes: "logistics, shipping, deliveries" },
  { name: "globe", themes: "international, the web, websites" },
  { name: "leaf", themes: "sustainability, nature, the environment" },
] as const;

export type WorkspaceIcon = (typeof WORKSPACE_ICONS)[number]["name"];

export const WORKSPACE_ICON_NAMES: readonly WorkspaceIcon[] = WORKSPACE_ICONS.map((i) => i.name);

const NAMES = new Set<string>(WORKSPACE_ICON_NAMES);

export const isWorkspaceIcon = (name: unknown): name is WorkspaceIcon => typeof name === "string" && NAMES.has(name);

/** What asks for no icon: nothing, an empty text, or "none" (what a command line can say). */
export const isNoIcon = (name: string | null | undefined): boolean => name === null || name === undefined || name.trim() === "" || name.trim().toLowerCase() === "none";

/**
 * The icons whose themes speak of a word, best first: the theme starts with it, then a word of the theme does
 * ("legal" → scales). For a hint when someone asks for an icon by its topic.
 */
export function iconsFor(word: string): WorkspaceIcon[] {
  const w = word.trim().toLowerCase();
  if (w.length < 2) return [];
  const themes = (i: (typeof WORKSPACE_ICONS)[number]) => i.themes.toLowerCase().split(/,\s*/);
  const exact = WORKSPACE_ICONS.filter((i) => themes(i).some((t) => t === w || t === `${w}s` || `${t}s` === w));
  const words = WORKSPACE_ICONS.filter((i) => !exact.includes(i) && themes(i).some((t) => t.split(/[\s-]+/).some((p) => p.startsWith(w))));
  return [...exact, ...words].map((i) => i.name);
}
