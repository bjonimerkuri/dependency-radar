import type { ExplanationFinding } from './ai.ts';
import type { Confidence, UpdateAnalysis } from './analyze.ts';
import type { SymbolMention } from './changelog.ts';

export type FinalLevel = 'safe' | 'review' | 'breaking' | 'unknown';

export interface Verdict {
  level: FinalLevel;
  confidence: Confidence;
  reasons: string[];
}

export type EvidenceStatus =
  | 'found'
  | 'no-repository'
  | 'not-github'
  | 'not-found'
  | 'no-versions'
  | 'rate-limited'
  | 'error'
  | 'skipped';

export interface ChangelogEvidence {
  status: EvidenceStatus;
  source?: 'file' | 'releases';
  repository?: string;
  sections: number;
  lineCount: number;
  truncated: boolean;
  mentions: SymbolMention[];
  message?: string;
}

function listNames(names: readonly string[]): string {
  const shown = names.slice(0, 4).join(', ');
  return names.length > 4 ? `${shown} and ${names.length - 4} more` : shown;
}

export function decideVerdict(
  result: UpdateAnalysis,
  evidence: ChangelogEvidence | undefined,
  findings: readonly ExplanationFinding[] = [],
): Verdict | undefined {
  if (result.status !== 'analyzed') return undefined;

  const base: Confidence = result.confidence ?? 'low';
  if (result.kind === 'none') return { level: 'safe', confidence: base, reasons: ['Already up to date.'] };
  if (result.preliminary === 'safe') {
    return { level: 'safe', confidence: base, reasons: ['Compatible according to semver.'] };
  }
  if (result.preliminary === undefined || result.preliminary === 'unknown') {
    return { level: 'unknown', confidence: 'low', reasons: result.reasons.slice(0, 1) };
  }

  const impact = result.impact;
  const usesCode = impact?.level === 'used' || impact?.level === 'type-only';
  const usedNames = new Set([...(impact?.symbols ?? []), ...(impact?.members ?? [])]);
  const mentions = evidence?.mentions ?? [];
  const severe = mentions.filter((mention) => mention.inBreaking).map((mention) => mention.symbol);
  const aiBreaking = findings
    .filter((finding) => finding.kind === 'breaking' && finding.symbol !== undefined && usedNames.has(finding.symbol))
    .map((finding) => finding.symbol as string);
  const found = evidence?.status === 'found';

  if (usesCode && (severe.length > 0 || aiBreaking.length > 0)) {
    const names = [...new Set([...severe, ...aiBreaking])];
    return {
      level: 'breaking',
      confidence: base === 'high' && found ? 'high' : 'medium',
      reasons: [`Your code uses ${listNames(names)}, which the changelog marks as changed or removed.`],
    };
  }

  if (usesCode && mentions.length > 0) {
    return {
      level: 'review',
      confidence: 'medium',
      reasons: [
        `The changelog mentions ${listNames(mentions.map((mention) => mention.symbol))}, which your code uses, but not clearly as a breaking change. Check those usages.`,
      ],
    };
  }

  if (result.preliminary === 'breaking-candidate') {
    if (impact === undefined) {
      return { level: 'review', confidence: 'low', reasons: ['Major version change. Your code was not scanned.'] };
    }
    if (usesCode) {
      return found
        ? {
            level: 'review',
            confidence: 'medium',
            reasons: ['Major version change. Your code uses this package, and the changelog does not mention the names you import. Likely fine, but verify.'],
          }
        : {
            level: 'review',
            confidence: 'low',
            reasons: ['Major version change. Your code uses this package, and no changelog was found, so I am not sure.'],
          };
    }
    return {
      level: 'review',
      confidence: 'low',
      reasons: ['Major version change. Your code does not appear to import this package directly, but tooling or config may still use it.'],
    };
  }

  return { level: 'review', confidence: found && base !== 'low' ? 'medium' : 'low', reasons: result.reasons.slice(0, 1) };
}
