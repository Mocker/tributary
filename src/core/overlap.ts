import { Claim, OverlapResult, SymbolIndex } from '../types';

/**
 * Normalizes file paths for consistent comparison (strips leading ./, duplicate slashes)
 */
export function normalizePath(p: string): string {
  let cleaned = p.trim().replace(/^\.\//, '');
  cleaned = cleaned.replace(/\/+/g, '/');
  return cleaned;
}

/**
 * Checks if two path patterns overlap (exact match, prefix match, or glob match)
 */
export function pathsOverlap(pathA: string, pathB: string): boolean {
  const a = normalizePath(pathA);
  const b = normalizePath(pathB);

  if (a === b) return true;

  // Handle glob '**'
  if (a === '**' || b === '**') return true;

  if (a.endsWith('/**')) {
    const prefix = a.slice(0, -3);
    if (b === prefix || b.startsWith(prefix + '/')) return true;
  }
  if (b.endsWith('/**')) {
    const prefix = b.slice(0, -3);
    if (a === prefix || a.startsWith(prefix + '/')) return true;
  }

  // Handle prefix directory without glob: e.g. "src/" vs "src/session.ts"
  if (a.endsWith('/')) {
    if (b.startsWith(a)) return true;
  }
  if (b.endsWith('/')) {
    if (a.startsWith(b)) return true;
  }

  // Handle direct file vs folder
  if (a + '/' === b || b + '/' === a) return true;

  return false;
}

/**
 * Detects semantic overlap between a new claim and all currently active claims.
 * Deterministic, explainable — returns a concise 1-sentence reason.
 */
export function detectOverlap(
  newClaim: {
    agentId: string;
    paths: string[];
    symbols?: string[];
  },
  activeClaims: Claim[],
  symbolIndex: SymbolIndex = { symbols: {} }
): OverlapResult {
  const now = Date.now();
  // Filter for claims that are currently active and not expired
  const validClaims = activeClaims.filter(
    (c) => c.status === 'active' && c.leaseExpiresAt > now
  );

  const newPaths = (newClaim.paths || []).map(normalizePath);
  const newSymbols = newClaim.symbols || [];

  // Map new symbols to their target file paths
  const newSymbolFiles = new Map<string, string>();
  for (const sym of newSymbols) {
    const file = symbolIndex.symbols[sym];
    if (file) {
      newSymbolFiles.set(sym, normalizePath(file));
    }
  }

  for (const existing of validClaims) {
    const existingPaths = existing.paths.map(normalizePath);
    const existingSymbols = existing.symbols || [];

    // 1. Direct path overlap
    for (const pNew of newPaths) {
      for (const pExist of existingPaths) {
        if (pathsOverlap(pNew, pExist)) {
          return {
            hasOverlap: true,
            conflictingClaim: existing,
            reason: `conflicts with ${existing.agentId}'s claim on ${pExist} (overlapping path ${pNew})`,
          };
        }
      }
    }

    // 2. Direct symbol collision
    for (const sNew of newSymbols) {
      if (existingSymbols.includes(sNew)) {
        const file = symbolIndex.symbols[sNew] || 'shared module';
        return {
          hasOverlap: true,
          conflictingClaim: existing,
          reason: `conflicts with ${existing.agentId}'s claim on ${file} (symbol ${sNew})`,
        };
      }
    }

    // 3. New symbol maps to a file already claimed by an existing path
    for (const [sym, targetFile] of newSymbolFiles.entries()) {
      for (const pExist of existingPaths) {
        if (pathsOverlap(targetFile, pExist)) {
          return {
            hasOverlap: true,
            conflictingClaim: existing,
            reason: `conflicts with ${existing.agentId}'s claim on ${pExist} (symbol ${sym} resolves to ${targetFile})`,
          };
        }
      }
    }

    // 4. Existing symbol maps to a file claimed by a new path
    for (const sExist of existingSymbols) {
      const existingTargetFile = symbolIndex.symbols[sExist];
      if (existingTargetFile) {
        const normTarget = normalizePath(existingTargetFile);
        for (const pNew of newPaths) {
          if (pathsOverlap(pNew, normTarget)) {
            return {
              hasOverlap: true,
              conflictingClaim: existing,
              reason: `conflicts with ${existing.agentId}'s claim on ${normTarget} (symbol ${sExist})`,
            };
          }
        }
      }
    }
  }

  return { hasOverlap: false };
}
