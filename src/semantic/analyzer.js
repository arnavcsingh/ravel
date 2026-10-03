/** Narrow, explicit demo rule. General model-based assessment is an adapter extension. */
export function assessIdentifierMigration({ observed, current, consumer }) {
  const integerId = /\bid\s+INTEGER\b/i.test(observed);
  const uuidId = /\bid\s+UUID\b/i.test(current);
  const numericId = /\bid\s*:\s*number\b/.test(consumer);
  if (integerId && uuidId && numericId) {
    return {
      relevance: 'likely', analyzer: 'demo-rule-v1', affected_symbols: ['User.id'],
      explanation: 'The schema changed User.id from INTEGER to UUID, but the generated TypeScript interface still declares id as a number. This narrow demo rule identifies a likely contract mismatch; it does not prove general semantic correctness.',
    };
  }
  return { relevance: 'possible', analyzer: 'demo-rule-v1', affected_symbols: [], explanation: 'The input contents changed. This demo rule cannot establish whether the difference affects the output.' };
}
