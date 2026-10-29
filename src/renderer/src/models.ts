import type { ModelOption, ModelPricing } from "../../shared/types";

export interface ModelGroup {
  /** The provider the models come from ("OpenCode Zen", "tokenharbor"), or "" when there's one. */
  group: string;
  models: { id: string; label: string; cost?: ModelPricing }[];
}

/** Split "Provider/Model" (label first, then id) into a group and the model's own name. */
function split(m: ModelOption): { group: string; label: string } {
  const at = m.label.indexOf("/");
  if (at > 0) return { group: m.label.slice(0, at), label: m.label.slice(at + 1) };
  const id = m.id.indexOf("/");
  if (id > 0) return { group: m.id.slice(0, id), label: m.label.includes("/") ? m.label.slice(m.label.indexOf("/") + 1) : m.label };
  return { group: "", label: m.label };
}

/**
 * The models matching `query` (every word must appear in the label, id or
 * provider), grouped by provider in their original order.
 */
export function filterModels(models: ModelOption[], query: string): ModelGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const groups: ModelGroup[] = [];
  for (const m of models) {
    const { group, label } = split(m);
    const hay = `${m.label} ${m.id} ${group}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    let g = groups.find((x) => x.group === group);
    if (!g) groups.push((g = { group, models: [] }));
    g.models.push({ id: m.id, label, ...(m.cost && { cost: m.cost }) });
  }
  return groups;
}
