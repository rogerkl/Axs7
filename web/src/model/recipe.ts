import type { Recipe, Sample } from './types';

/** No edits: the original as it is */
export function plainRecipe(): Recipe {
  return { resampleTo: null, normalize: false, twelveBit: false, attackMs: 0, attackShape: 'linear', crossfadeMs: 0,
    crossfadeShape: 'linear' };
}

export function isEdited(recipe: Recipe): boolean {
  const plain = plainRecipe();
  return recipe.resampleTo !== null || recipe.normalize !== plain.normalize || recipe.twelveBit !== plain.twelveBit
    || recipe.attackMs > 0 || recipe.crossfadeMs > 0;
}

/** What a sample's rendered audio depends on: when it changes, the sample is rendered again */
export function renderKey(s: Sample): string {
  return JSON.stringify([s.fromSampler ? null : s.recipe, s.start, s.end, s.loopStart, s.loopEnd, s.loopMode,
    s.reverse, s.source.length, s.sourceRate]);
}
