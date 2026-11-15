export function displayNameFor(modelId: string): string {
  const clean = modelId.replace(/^chatgpt\//, '').toLowerCase();
  switch (clean) {
    case 'gpt-4o':
      return 'GPT-4o (Omni)';
    case 'o3-mini':
      return 'OpenAI o3-mini';
    case 'o1':
      return 'OpenAI o1';
    case 'gpt-4o-mini':
      return 'GPT-4o Mini';
    case 'o1-mini':
      return 'OpenAI o1-mini';
    case 'auto':
      return 'ChatGPT Auto (Default)';
    case 'gpt-4':
      return 'GPT-4 (Legacy)';
    default:
      return modelId;
  }
}

export function displayNamesFor(
  models: readonly { modelId: string; displayName?: string }[],
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const model of models) {
    names[model.modelId] = model.displayName ?? displayNameFor(model.modelId);
  }
  return names;
}
