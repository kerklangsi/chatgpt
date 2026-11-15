import { ModelQuota } from './types';

/**
 * One distinct quota pool, fronted by a single model.
 *
 * ChatGPT may report several models against one quota window. Folding them to
 * one entry per bucket keeps the quota readable in the panel and status bar.
 */
export interface QuotaPool<T extends ModelQuota = ModelQuota> {
  /** Model shown as the face of the pool. */
  model: T;
  /** Models drawing from this pool, the representative included. */
  memberCount: number;
}

/**
 * Preferred faces for a pool when the upstream has not said which models are
 * current, most wanted first. Whichever member matches the earliest pattern
 * represents the bucket; anything unmatched falls back to the largest-context
 * model in the pool.
 */
const REPRESENTATIVE_PRIORITY: RegExp[] = [
  /^gpt-4o/,
  /^o3/,
  /^o1/,
  /^gpt/,
  /^auto$/,
];

/** Vendor families, in the order a user cares about them. */
const FAMILIES: { id: string; pattern: RegExp }[] = [
  { id: 'gpt', pattern: /^(gpt|auto)/ },
  { id: 'o-series', pattern: /^o\d/ },
];

/**
 * Fold models that share a vendor, a reset window and a remaining percentage
 * into one pool each — that combination is the bucket's fingerprint. Models
 * without a reset timestamp cannot be matched up, so they stay on their own.
 *
 * The model family belongs in the key even though it is not part of the bucket,
 * so unrelated models with matching quota values do not get merged.
 *
 * Pools come back tightest-quota-first.
 */
export function quotaPools<T extends ModelQuota>(models: T[]): QuotaPool<T>[] {
  const pools = new Map<string, T[]>();

  for (const model of models) {
    const key = model.resetTime
      ? `${modelFamily(model.modelId)}|${model.resetTime}|${model.percentage}`
      : `model:${model.modelId}`;
    const members = pools.get(key);
    if (members) {
      members.push(model);
    } else {
      pools.set(key, [model]);
    }
  }

  return [...pools.values()]
    .map((members) => ({ model: pickRepresentative(members), memberCount: members.length }))
    .sort(
      (a, b) =>
        a.model.percentage - b.model.percentage ||
        familyRank(modelFamily(a.model.modelId)) - familyRank(modelFamily(b.model.modelId)),
    );
}

function pickRepresentative<T extends ModelQuota>(members: T[]): T {
  const rank = (model: T) => {
    const index = REPRESENTATIVE_PRIORITY.findIndex((pattern) => pattern.test(model.modelId));
    return index === -1 ? REPRESENTATIVE_PRIORITY.length : index;
  };

  // The declared ChatGPT model order takes precedence over inferred names.
  const listed = (model: T) => model.agentOrder ?? Number.MAX_SAFE_INTEGER;

  return [...members].sort(
    (a, b) =>
      listed(a) - listed(b) ||
      rank(a) - rank(b) ||
      (b.maxTokens ?? 0) - (a.maxTokens ?? 0) ||
      (a.displayName ?? a.modelId).localeCompare(b.displayName ?? b.modelId),
  )[0];
}

/** ChatGPT family of a model id: GPT, o-series, or other. */
export function modelFamily(modelId: string): string {
  return FAMILIES.find((family) => family.pattern.test(modelId))?.id ?? 'other';
}

function familyRank(family: string): number {
  const index = FAMILIES.findIndex((candidate) => candidate.id === family);
  return index === -1 ? FAMILIES.length : index;
}
