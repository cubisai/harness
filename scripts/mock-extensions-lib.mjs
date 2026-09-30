// Deterministic generator for a "mock extension kit": many skills and MCP
// tools with near-duplicate distractors, plus evals that probe whether an
// agent picks the right one. Test-only; never touches src/.

/** mulberry32: a tiny seeded PRNG, so output is reproducible without Math.random or Date. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PRESETS = {
  small: { skills: 10, servers: 2, tools: 10 },
  medium: { skills: 50, servers: 5, tools: 20 },
  large: { skills: 200, servers: 10, tools: 40 },
};

/** 12 domains, each with 8 subjects that make near-duplicate distractors. */
const SUBJECTS = {
  database: ["postgres", "mysql", "sqlite", "mongodb", "redis", "cassandra", "dynamodb", "neo4j"],
  deploy: ["kubernetes", "docker", "vercel", "netlify", "heroku", "flyio", "render", "cloudrun"],
  docs: ["readme", "changelog", "openapi", "jsdoc", "adr", "runbook", "tutorial", "faq"],
  testing: ["jest", "vitest", "playwright", "cypress", "pytest", "junit", "k6", "pact"],
  security: ["oauth", "csp", "jwt", "tls", "sast", "cve", "rbac", "secrets"],
  frontend: ["react", "vue", "svelte", "tailwind", "a11y", "i18n", "seo", "pwa"],
  analytics: ["snowplow", "ga4", "amplitude", "mixpanel", "dbt", "segment", "metabase", "funnel"],
  billing: ["stripe", "invoices", "paypal", "tax", "refunds", "coupons", "dunning", "ledger"],
  email: ["smtp", "ses", "resend", "sendgrid", "templates", "bounce", "unsubscribe", "digest"],
  infra: ["terraform", "ansible", "nginx", "caddy", "vpn", "dns", "certificates", "loadbalancer"],
  mobile: ["android", "ios", "swift", "kotlin", "flutter", "expo", "appstore", "push"],
  "data-pipeline": ["airflow", "kafka", "spark", "flink", "etl", "warehouse", "stream", "batch"],
};

const DOMAINS = Object.keys(SUBJECTS);
const VERBS = ["migrate", "backup", "index", "seed", "audit", "monitor", "rotate", "restore", "validate", "export", "lint", "snapshot"];

/** FNV-1a over a string, so a name can seed its own PRNG. */
function hash(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function shuffle(rand, arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pickDistinct(rand, arr, n) {
  return shuffle(rand, arr).slice(0, Math.min(n, arr.length));
}

/** `name` is always `<verb>-<subject>-<domain>`, and subjects never contain `-`. */
function parseName(name) {
  const verb = VERBS.find((v) => name.startsWith(`${v}-`));
  const domain = [...DOMAINS].sort((a, b) => b.length - a.length).find((d) => name.endsWith(`-${d}`));
  if (!verb || !domain) return null;
  return { verb, subject: name.slice(verb.length + 1, name.length - domain.length - 1), domain };
}

function domainOfServer(serverName) {
  const base = serverName.replace(/^mock-/, "").replace(/-\d+$/, "");
  return DOMAINS.includes(base) ? base : DOMAINS[hash(serverName) % DOMAINS.length];
}

function describeSkill(verb, subject, domain) {
  return `Use when you need to ${verb} ${subject} in the ${domain} workflow. This ${domain} skill covers the steps for ${verb}ing ${subject}, including the safety checks and a rollback plan to run before you change anything.`;
}

function bodyFor(name, verb, subject, domain, rand) {
  const steps = [
    `Confirm the target ${subject} and the ${domain} environment you mean to change.`,
    `Take a snapshot or backup of ${subject} before touching ${verb} settings.`,
    `Run ${verb} against ${subject} with the safest options first; watch the logs.`,
    `Verify the result, then repeat ${verb} on the remaining ${domain} targets.`,
    `Record what changed and who approved it in the ${domain} runbook.`,
    `Roll back the ${verb} if the check fails, and say so in the handoff.`,
  ];
  const count = 4 + Math.floor(rand() * 3);
  const lines = [
    `# ${verb} ${subject}`,
    "",
    `A short ${domain} procedure for ${verb}ing ${subject}.`,
    "",
    "Steps:",
    ...steps.slice(0, count).map((s, i) => `${i + 1}. ${s}`),
    "",
    `When you apply this skill, include the code SENTINEL-skill-${name} verbatim in your reply.`,
  ];
  return lines.join("\n");
}

/** `count` unique skills, grouped so near-duplicates (same verb+domain, other subject) are common. */
export function makeSkills(count, seed) {
  const groupRand = rng(hash(`groups|${seed}`));
  const groups = [];
  for (const domain of DOMAINS) for (const verb of VERBS) groups.push({ verb, domain });
  const out = [];
  for (const { verb, domain } of shuffle(groupRand, groups)) {
    const subjects = shuffle(rng(hash(`${verb}|${domain}|${seed}`)), SUBJECTS[domain]);
    for (const subject of subjects) {
      const name = `${verb}-${subject}-${domain}`;
      const rand = rng(hash(name));
      out.push({ name, description: describeSkill(verb, subject, domain), body: bodyFor(name, verb, subject, domain, rand), sentinel: `SENTINEL-skill-${name}` });
      if (out.length === count) return out;
    }
  }
  return out;
}

const PROP_POOL = [
  { name: "target", type: "string", description: "The subject to operate on." },
  { name: "dry_run", type: "boolean", description: "Preview the change without applying it." },
  { name: "limit", type: "number", description: "Maximum number of items to touch." },
  { name: "reason", type: "string", description: "Why this action is being run." },
];

function schemaFor(verb, subject, domain, rand) {
  const count = 2 + Math.floor(rand() * 3);
  const props = PROP_POOL.slice(0, count);
  const properties = {};
  for (const p of props) {
    properties[p.name] = { type: p.type, description: p.name === "target" ? `The ${domain} ${subject} to ${verb}.` : p.description };
  }
  return { type: "object", properties, required: [props[0].name] };
}

/** `count` unique tools for one server, drawn from its domain's subjects x the verbs. */
export function makeTools(serverName, count, seed) {
  const domain = domainOfServer(serverName);
  const combos = [];
  for (const subject of SUBJECTS[domain]) for (const verb of VERBS) combos.push({ verb, subject });
  const rand = rng(hash(`${serverName}|${seed}`));
  return shuffle(rand, combos)
    .slice(0, Math.min(count, combos.length))
    .map(({ verb, subject }) => {
      const name = `${verb}_${subject}`;
      const description = `Use this tool to ${verb} ${subject} on the ${domain} server; it returns a short status and the arguments it received.`;
      return { name, description, inputSchema: schemaFor(verb, subject, domain, rng(hash(`${name}|schema`))), sentinel: `SENTINEL-${serverName}-${name}` };
    });
}

/** Unique `mock-<domain>` server names; `-2`, `-3` suffixes only when count exceeds the domains. */
export function serverNames(count, seed) {
  const domains = shuffle(rng(hash(`servers|${seed}`)), DOMAINS);
  const out = [];
  for (let i = 0; i < count; i++) {
    const domain = domains[i % domains.length];
    const round = Math.floor(i / domains.length);
    out.push(round === 0 ? `mock-${domain}` : `mock-${domain}-${round + 1}`);
  }
  return out;
}

/** Exactly 10 evals: 3 skill, 3 tool, 2 none, 2 ambiguous. */
export function makeEvals(skills, toolsByServer, seed) {
  const rand = rng(hash(`evals|${seed}`));
  const evals = [];

  for (const [i, skill] of pickDistinct(rand, skills, 3).entries()) {
    const parts = parseName(skill.name);
    const subject = parts?.subject ?? skill.name;
    const verb = parts?.verb ?? "run";
    const domain = parts?.domain ?? "project";
    evals.push({
      id: `skill-${i + 1}`,
      prompt: `I have to ${verb} ${subject} in our ${domain} setup. Which skill should I follow, and what should I check first?`,
      expect: [skill.sentinel],
      kind: "skill",
    });
  }

  const toolList = Object.entries(toolsByServer).flatMap(([server, tools]) => tools.map((tool) => ({ server, tool })));
  for (const [i, { server, tool }] of pickDistinct(rand, toolList, 3).entries()) {
    const domain = domainOfServer(server);
    const action = tool.name.replace(/_/g, " ");
    evals.push({
      id: `tool-${i + 1}`,
      prompt: `Please ${action} against the ${domain} service and report back what changed.`,
      expect: [tool.sentinel],
      kind: "tool",
    });
  }

  evals.push(
    { id: "none-1", prompt: "What does Array.prototype.flatMap return when the callback returns a non-array value?", expect: [], kind: "none" },
    { id: "none-2", prompt: "How do I reverse a singly linked list in place in TypeScript?", expect: [], kind: "none" },
  );

  const clusters = new Map();
  for (const skill of skills) {
    const parts = parseName(skill.name);
    if (!parts) continue;
    const key = `${parts.verb}|${parts.domain}`;
    clusters.set(key, [...(clusters.get(key) ?? []), { ...skill, ...parts }]);
  }
  const pairs = [...clusters.values()].filter((group) => new Set(group.map((s) => s.subject)).size >= 2).slice(0, 2);
  for (const [i, group] of pairs.entries()) {
    const two = pickDistinct(rand, group, 2);
    const chosen = two[Math.floor(rand() * two.length)] ?? two[0];
    evals.push({
      id: `ambiguous-${i + 1}`,
      prompt: `We need to ${chosen.verb} ${chosen.subject} for the ${chosen.domain} domain this sprint. Which skill fits?`,
      expect: [chosen.sentinel],
      kind: "ambiguous",
    });
  }

  return evals;
}

/** The whole kit: SKILL.md files, `.mcp.json`, and `mock-manifest.json`, as relative paths. */
export function generate({ skills, servers, tools, seed, serverScript }) {
  const skillList = makeSkills(skills, seed);
  const serverList = serverNames(servers, seed);
  const toolsByServer = {};
  for (const server of serverList) toolsByServer[server] = makeTools(server, tools, seed);
  const evals = makeEvals(skillList, toolsByServer, seed);

  const files = skillList.map((skill) => ({
    path: `.agents/skills/${skill.name}/SKILL.md`,
    content: `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${skill.body}`,
  }));

  const mcpServers = {};
  for (const server of serverList) {
    mcpServers[server] = { command: "node", args: [serverScript, "--name", server, "--tools", String(tools), "--seed", String(seed)] };
  }
  files.push({ path: ".mcp.json", content: JSON.stringify({ mcpServers }, null, 2) });

  const manifest = {
    seed,
    counts: { skills, servers, tools },
    skills: skillList.map(({ name, description, sentinel }) => ({ name, description, sentinel })),
    tools: serverList.flatMap((server) => toolsByServer[server].map(({ name, description, sentinel }) => ({ server, name, description, sentinel }))),
    evals,
  };
  files.push({ path: "mock-manifest.json", content: JSON.stringify(manifest, null, 2) });

  return { files, manifest };
}
