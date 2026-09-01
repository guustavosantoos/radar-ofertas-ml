import { DealTier } from '@radar-ofertas/domain';

export function calculateTier(score: number): DealTier {
  if (score >= 85) return 'IMPERDÍVEL';
  if (score >= 70) return 'ÓTIMA';
  if (score >= 50) return 'BOA';
  return 'NORMAL';
}
