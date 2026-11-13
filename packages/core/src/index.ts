export * from './types.ts';
export { parseSpecifier } from './specifier.ts';
export { readProject, DEFAULT_MAX_PACKAGE_JSON_BYTES, DEFAULT_MAX_LOCKFILE_BYTES } from './read-project.ts';
export { parseLockfile } from './lockfile.ts';
export type { LockfileIndex, LockfileResult } from './lockfile.ts';
export { findJsonSyntaxError } from './json-syntax.ts';
export type { JsonSyntaxIssue } from './json-syntax.ts';
export { groupByName } from './group.ts';
export {
  ALLOWED_REGISTRY_HOSTS,
  createRegistryClient,
  normalizePackument,
} from './registry.ts';
export type {
  FetchPackumentResult,
  Packument,
  RegistryClient,
  RegistryClientOptions,
  RegistryErrorCode,
  VersionInfo,
} from './registry.ts';
export { createMemoryCache, withCache, withChangelogCache, withManifestCache } from './cache.ts';
export type { MemoryCacheOptions, PackumentCache, TtlCacheOptions, WithCacheOptions } from './cache.ts';
export { analyzeEntry, analyzeProject } from './analyze.ts';
export type {
  AnalysisSummary,
  AnalyzeProjectOptions,
  Confidence,
  PeerConflict,
  Preliminary,
  ProjectAnalysis,
  UpdateAnalysis,
  UpdateKind,
} from './analyze.ts';
export { scanSourceFile } from './scan-file.ts';
export type { FileScan, ImportKind, ImportRecord, ImportedSymbol } from './scan-file.ts';
export { IGNORED_DIRECTORIES, scanProject } from './scan-project.ts';
export type { ScanOptions, ScanResult, SkipReason, SkippedFile, SourceFile } from './scan-project.ts';
export { createAliasMatcher, readTsconfigAliasKeys } from './tsconfig-aliases.ts';
export { resolvePackageReference } from './module-specifier.ts';
export type { ModuleReference, SpecifierContext } from './module-specifier.ts';
export { buildUsageIndex, computeImpact, isInScripts } from './usage.ts';
export type { ImpactLevel, PackageImpact, PackageUsage } from './usage.ts';
export { attachImpact, describeImpact } from './impact.ts';
export type { NpmRegistry, ManifestClient, ManifestInfo, FetchManifestResult } from './registry.ts';
export { parseRepositoryField } from './repository.ts';
export type { RepositoryRef } from './repository.ts';
export {
  buildChangelogLines,
  findSymbolMentions,
  parseVersionSections,
  sectionsBetween,
  selectForPrompt,
} from './changelog.ts';
export type { ChangelogLine, PromptSelection, SymbolMention, VersionSection } from './changelog.ts';
export { createGithubChangelogSource, parseTagVersion } from './github.ts';
export { getBytes, getText } from './http.ts';
export type { HttpBytesOptions, HttpBytesResult, HttpErrorCode, HttpTextOptions, HttpTextResult } from './http.ts';
export type {
  ChangelogFetchResult,
  ChangelogRequest,
  ChangelogSource,
  GithubRepository,
  GithubSourceOptions,
} from './github.ts';
export { buildPrompt, createOpenAiCompatibleProvider, explainUpdate, KNOWN_AI_HOSTS, parseExplanation } from './ai.ts';
export type {
  AiErrorCode,
  AiProvider,
  AiRequest,
  AiResult,
  ExplainInput,
  ExplainOptions,
  ExplainResult,
  ExplanationFinding,
  FindingKind,
  OpenAiCompatibleOptions,
  UpdateExplanation,
} from './ai.ts';
export { decideVerdict } from './decide.ts';
export type { ChangelogEvidence, EvidenceStatus, FinalLevel, Verdict } from './decide.ts';
export { enrichWithChangelogs } from './enrich.ts';
export type { EnrichDeps } from './enrich.ts';
export { classify, excerptText, reasonLines, summaryCounts } from './report.ts';
export type { Classification, ScanInfo, SummaryCount, Tone } from './report.ts';
export { escapeHtml, formatHtml, REPORT_STYLE } from './html.ts';
export type { HtmlOptions } from './html.ts';
export { assessRepository, summarizeSignals } from './risk-assess.ts';
export type { AssessOptions, RepositoryInput } from './risk-assess.ts';
export { findLookalike, isPopularPackage, POPULAR_PACKAGES } from './risk-lookalike.ts';
export type { Lookalike } from './risk-lookalike.ts';
export { scanTextForRisks } from './risk-patterns.ts';
export type { PatternMatch } from './risk-patterns.ts';
export { analyzeCommand, isBenignCommand, LIFECYCLE_SCRIPTS, referencedScriptFiles, referencedScriptNames } from './risk-scripts.ts';
export type { CommandFinding } from './risk-scripts.ts';
export { createNpmStatsSource, refineLookalikes } from './risk-stats.ts';
export type { NpmStatsOptions, RefineOptions, StatsSource } from './risk-stats.ts';
export { SEVERITY_RANK } from './risk-types.ts';
export type { RiskConfidence, RiskReport, RiskSeverity, RiskSignal } from './risk-types.ts';
export { formatRiskHtml, riskHeadline } from './risk-html.ts';
export type { RiskHtmlOptions } from './risk-html.ts';
export { applyEdits, detectIndentUnit, detectNewline, memberOf, parseJsonOffsets, setJsonMember } from './json-edit.ts';
export type { JsonMember, JsonNode, TextEdit } from './json-edit.ts';
export { computeDiff, unifiedDiff } from './diff.ts';
export type { DiffHunk, DiffLine } from './diff.ts';
export { parseTicket } from './ticket.ts';
export type { ParsedTicket, ParseTicketOptions, TicketFinding, TicketSeverity } from './ticket.ts';
export { buildLockGraph } from './lock-graph.ts';
export type { Dependent, LockGraph, LockNode } from './lock-graph.ts';
export { planMultiRemediation, planRemediation } from './remediate.ts';
export type {
  AffectedInstance,
  FindingPlan,
  FindingStatus,
  FixKind,
  FixOption,
  MultiRemediationInput,
  MultiRemediationPlan,
  MultiRemediationResult,
  PackageManager,
  RemediationInput,
  RemediationPlan,
  RemediationResult,
  RowStatus,
  TicketInput,
  TicketOutcome,
  TicketRow,
} from './remediate.ts';
export { ALLOWED_ADVISORY_HOSTS, createOsvSource, fixedVersionsFromOsv, planMultiRemediationWithLookup, planRemediationWithLookup } from './advisories.ts';
export type { AdvisorySource, LookupNote, LookupOptions, OsvSourceOptions } from './advisories.ts';
export { splitTickets } from './tickets.ts';
export type { SplitTicket, SplitTicketsOptions, SplitTicketsResult } from './tickets.ts';
export { buildPrDescription, PR_MAX_CHARS } from './pr-description.ts';
export type { PrDescription, PrFormat, PrLanguage, PrOptions, UsageLike } from './pr-description.ts';
export { FIX_LIMITS, fixHeadline, formatFixHtml } from './fix-html.ts';
export type { FixHtmlOptions } from './fix-html.ts';
export { applyMajorChecks, checkMajorFixChangelogs, describeMajorCheck } from './fix-changelog.ts';
export type { FixChangelogDeps, MajorCheckStatus, MajorFixCheck } from './fix-changelog.ts';
export { displayAdvisoryId } from './util.ts';
