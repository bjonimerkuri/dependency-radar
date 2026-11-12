export type RiskSeverity = 'info' | 'low' | 'medium' | 'high';
export type RiskConfidence = 'high' | 'medium' | 'low';

export interface RiskSignal {
  id: string;
  severity: RiskSeverity;
  confidence: RiskConfidence;
  title: string;
  detail: string;
  file?: string;
  line?: number;
  excerpt?: string;
  subject?: string;
}

export interface RiskReport {
  signals: RiskSignal[];
  highest: RiskSeverity | 'none';
  scannedFiles: number;
  checkedDependencies: number;
  truncated: boolean;
  limitations: string[];
}

export const SEVERITY_RANK: Readonly<Record<RiskSeverity, number>> = { info: 0, low: 1, medium: 2, high: 3 };

export function lowerSeverity(severity: RiskSeverity): RiskSeverity | undefined {
  switch (severity) {
    case 'high':
      return 'medium';
    case 'medium':
      return 'low';
    default:
      return undefined;
  }
}
