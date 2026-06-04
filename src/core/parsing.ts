import type { MarketWinner } from './domain.js';

export function parseOutcomes(rawOutcomes: unknown): string[] {
  return parseStringArray(rawOutcomes, 'outcomes');
}

export function parseOutcomePrices(rawOutcomePrices: unknown): number[] {
  return parseStringArray(rawOutcomePrices, 'outcomePrices').map((rawOutcomePrice) => {
    const outcomePrice = Number(rawOutcomePrice);
    if (!Number.isFinite(outcomePrice)) {
      throw new Error(`Invalid outcome price: ${rawOutcomePrice}`);
    }
    return outcomePrice;
  });
}

function parseStringArray(rawValue: unknown, fieldName: string): string[] {
  const parsedValue = typeof rawValue === 'string' ? safeParseJson(rawValue, fieldName) : rawValue;
  if (!Array.isArray(parsedValue)) {
    throw new Error(`${fieldName} must be an array or JSON array string`);
  }
  return parsedValue.map((entry) => String(entry));
}

function safeParseJson(rawValue: string, fieldName: string): unknown {
  try {
    return JSON.parse(rawValue) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse ${fieldName}: ${(error as Error).message}`);
  }
}

export interface TargetPriceSource {
  targetPrice?: unknown;
  target?: unknown;
  startPrice?: unknown;
  initialPrice?: unknown;
  question?: unknown;
  title?: unknown;
  description?: unknown;
  rules?: unknown;
  gameStartPrice?: unknown;
}

export function extractTargetPrice(targetPriceSource: TargetPriceSource): number | null {
  for (const explicitValue of [
    targetPriceSource.targetPrice,
    targetPriceSource.target,
    targetPriceSource.startPrice,
    targetPriceSource.initialPrice,
    targetPriceSource.gameStartPrice,
  ]) {
    const explicitTargetPrice = parsePotentialPrice(explicitValue);
    if (explicitTargetPrice !== null) {
      return explicitTargetPrice;
    }
  }

  const searchableText = [
    targetPriceSource.question,
    targetPriceSource.title,
    targetPriceSource.description,
    targetPriceSource.rules,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');

  // Polymarket crypto questions vary over time. These patterns intentionally require
  // start/target price language so random dates or market ids are not treated as BTC prices.
  const targetPricePatterns = [
    /(?:target|start(?:ing)?|open(?:ing)?|initial)\s*(?:price|value|level)?[^$0-9]{0,30}\$?([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]{4,6}(?:\.[0-9]+)?)/iu,
    /\$([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]{4,6}(?:\.[0-9]+)?)\s*(?:target|start(?:ing)?|open(?:ing)?|initial)/iu,
    /(?:above|below|higher|lower|up or down|up\/down)[^$0-9]{0,80}\$([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]{4,6}(?:\.[0-9]+)?)/iu,
  ];

  for (const targetPricePattern of targetPricePatterns) {
    const targetPriceMatch = targetPricePattern.exec(searchableText);
    const matchedPrice = targetPriceMatch?.[1];
    if (matchedPrice !== undefined) {
      return Number(matchedPrice.replaceAll(',', ''));
    }
  }

  return null;
}

function parsePotentialPrice(rawValue: unknown): number | null {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0) {
    return rawValue;
  }
  if (typeof rawValue === 'string') {
    const parsedValue = Number(rawValue.replaceAll(',', '').replace('$', '').trim());
    if (Number.isFinite(parsedValue) && parsedValue > 0) {
      return parsedValue;
    }
  }
  return null;
}

export function determineMarketWinner(rawMarket: Record<string, unknown>, outcomes: string[], outcomePrices: number[]): MarketWinner {
  const winnerField = rawMarket['winner'] ?? rawMarket['winningOutcome'] ?? rawMarket['resolvedOutcome'];
  if (typeof winnerField === 'string') {
    const normalizedWinner = winnerField.toLowerCase();
    if (normalizedWinner.includes('up') || normalizedWinner === 'yes') return 'up';
    if (normalizedWinner.includes('down') || normalizedWinner === 'no') return 'down';
  }

  const oneDollarIndex = outcomePrices.findIndex((outcomePrice) => outcomePrice >= 0.99);
  const oneDollarOutcome = outcomes[oneDollarIndex]?.toLowerCase();
  if (oneDollarOutcome?.includes('up') || oneDollarOutcome === 'yes') return 'up';
  if (oneDollarOutcome?.includes('down') || oneDollarOutcome === 'no') return 'down';

  return null;
}
