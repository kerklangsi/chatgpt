import { AccountManager } from '../accounts/accountManager';

export type ModelFamily = 'gpt' | 'o-series';

export interface CatalogModel {
  /** Model ID, e.g. gpt-4o, o3-mini. */
  id: string;
  displayName: string;
  family: ModelFamily;
  maxInputTokens: number;
  maxOutputTokens: number;
  thinkingBudget: number;
  supportsThinking: boolean;
  supportsImages: boolean;
  supportsTools: boolean;
  recommended?: boolean;
  quotaPercent?: number;
  accountEmail?: string;
  resetTime?: string;
  agentOrder?: number;
}

export type MatchKind = 'exact' | 'alias' | 'family' | 'any';

export interface ModelMatch {
  model: CatalogModel;
  kind: MatchKind;
}

const STATIC_MODELS: CatalogModel[] = [
  {
    id: 'gpt-4o',
    displayName: 'GPT-4o (Omni)',
    family: 'gpt',
    maxInputTokens: 128_000,
    maxOutputTokens: 16_384,
    thinkingBudget: 0,
    supportsThinking: false,
    supportsImages: true,
    supportsTools: true,
    recommended: true,
    agentOrder: 1,
  },
  {
    id: 'o3-mini',
    displayName: 'OpenAI o3-mini',
    family: 'o-series',
    maxInputTokens: 200_000,
    maxOutputTokens: 100_000,
    thinkingBudget: 32_768,
    supportsThinking: true,
    supportsImages: false,
    supportsTools: true,
    recommended: true,
    agentOrder: 2,
  },
  {
    id: 'o1',
    displayName: 'OpenAI o1',
    family: 'o-series',
    maxInputTokens: 200_000,
    maxOutputTokens: 100_000,
    thinkingBudget: 65_536,
    supportsThinking: true,
    supportsImages: true,
    supportsTools: true,
    agentOrder: 3,
  },
  {
    id: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    family: 'gpt',
    maxInputTokens: 128_000,
    maxOutputTokens: 16_384,
    thinkingBudget: 0,
    supportsThinking: false,
    supportsImages: true,
    supportsTools: true,
    agentOrder: 4,
  },
  {
    id: 'o1-mini',
    displayName: 'OpenAI o1-mini',
    family: 'o-series',
    maxInputTokens: 128_000,
    maxOutputTokens: 65_536,
    thinkingBudget: 16_384,
    supportsThinking: true,
    supportsImages: false,
    supportsTools: true,
    agentOrder: 5,
  },
  {
    id: 'auto',
    displayName: 'ChatGPT Auto (Default)',
    family: 'gpt',
    maxInputTokens: 128_000,
    maxOutputTokens: 16_384,
    thinkingBudget: 0,
    supportsThinking: false,
    supportsImages: true,
    supportsTools: true,
    agentOrder: 6,
  },
  {
    id: 'gpt-4',
    displayName: 'GPT-4 (Legacy)',
    family: 'gpt',
    maxInputTokens: 32_768,
    maxOutputTokens: 8_192,
    thinkingBudget: 0,
    supportsThinking: false,
    supportsImages: false,
    supportsTools: true,
    agentOrder: 7,
  },
];

export class ModelCatalog {
  constructor(private readonly accounts?: AccountManager) {}

  listAll(): CatalogModel[] {
    const active = this.accounts?.getActive();
    return STATIC_MODELS.map((m) => {
      const q = active?.quota?.models[m.id];
      return {
        ...m,
        quotaPercent: q?.percentage ?? (active ? 100 : 0),
        accountEmail: active?.email,
        resetTime: q?.resetTime,
      };
    });
  }

  get(id: string): CatalogModel | undefined {
    return this.listAll().find((m) => m.id === id);
  }

  match(requestedId: string): ModelMatch {
    const all = this.listAll();
    const clean = requestedId.replace(/^chatgpt\//, '').toLowerCase();

    const exact = all.find((m) => m.id.toLowerCase() === clean);
    if (exact) return { model: exact, kind: 'exact' };

    if (clean.includes('o3-mini')) {
      const o3 = all.find((m) => m.id === 'o3-mini');
      if (o3) return { model: o3, kind: 'alias' };
    }
    if (clean.includes('o1-mini')) {
      const o1m = all.find((m) => m.id === 'o1-mini');
      if (o1m) return { model: o1m, kind: 'alias' };
    }
    if (clean.includes('o1')) {
      const o1 = all.find((m) => m.id === 'o1');
      if (o1) return { model: o1, kind: 'alias' };
    }
    if (clean.includes('4o-mini')) {
      const mini = all.find((m) => m.id === 'gpt-4o-mini');
      if (mini) return { model: mini, kind: 'alias' };
    }
    if (clean.includes('4o')) {
      const gpt4o = all.find((m) => m.id === 'gpt-4o');
      if (gpt4o) return { model: gpt4o, kind: 'alias' };
    }
    if (clean.includes('gpt-4')) {
      const gpt4 = all.find((m) => m.id === 'gpt-4');
      if (gpt4) return { model: gpt4, kind: 'alias' };
    }

    const fallback = all.find((m) => m.id === 'gpt-4o') || all[0];
    return { model: fallback, kind: 'any' };
  }
}
