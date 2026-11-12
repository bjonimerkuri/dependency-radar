import ts from 'typescript';
import { resolvePackageReference } from './module-specifier.ts';
import type { SpecifierContext } from './module-specifier.ts';

export type ImportKind = 'static' | 'dynamic' | 'require' | 'export-from' | 'import-equals';

export interface ImportedSymbol {
  imported: string;
  local?: string;
  typeOnly: boolean;
}

export interface ImportRecord {
  filePath: string;
  specifier: string;
  packageName: string;
  subpath?: string;
  kind: ImportKind;
  typeOnly: boolean;
  symbols: ImportedSymbol[];
  members: string[];
  line: number;
  column: number;
  appearsUnused: boolean;
}

export interface FileScan {
  imports: ImportRecord[];
  error?: string;
}

interface ModuleCall {
  specifier: string;
  kind: 'require' | 'dynamic';
}

function scriptKindFor(path: string): ts.ScriptKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(lower)) return ts.ScriptKind.TS;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function symbol(imported: string, local: string | undefined, typeOnly: boolean): ImportedSymbol {
  return local === undefined ? { imported, typeOnly } : { imported, local, typeOnly };
}

function moduleCall(expression: ts.Expression): ModuleCall | undefined {
  let node: ts.Expression = expression;
  while (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) node = node.expression;
  if (!ts.isCallExpression(node)) return undefined;
  const first = node.arguments[0];
  if (first === undefined || !ts.isStringLiteralLike(first)) return undefined;
  if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
    return { specifier: first.text, kind: 'require' };
  }
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return { specifier: first.text, kind: 'dynamic' };
  }
  return undefined;
}

function symbolsFromBinding(name: ts.BindingName): ImportedSymbol[] {
  if (ts.isIdentifier(name)) return [symbol('*', name.text, false)];
  if (!ts.isObjectBindingPattern(name)) return [];
  const symbols: ImportedSymbol[] = [];
  for (const element of name.elements) {
    const local = ts.isIdentifier(element.name) ? element.name.text : undefined;
    if (element.dotDotDotToken) {
      symbols.push(symbol('*', local, false));
      continue;
    }
    const key = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined);
    if (key === undefined || !(ts.isIdentifier(key) || ts.isStringLiteral(key))) continue;
    symbols.push(symbol(key.text, local, false));
  }
  return symbols;
}

function leftmost(name: ts.EntityName): string {
  let current: ts.EntityName = name;
  while (ts.isQualifiedName(current)) current = current.left;
  return current.text;
}

export function scanSourceFile(path: string, content: string, context: SpecifierContext): FileScan {
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindFor(path));
  } catch {
    return { imports: [], error: 'The file could not be parsed.' };
  }

  const records: ImportRecord[] = [];
  const identifierCounts = new Map<string, number>();
  const memberAccesses: Array<[string, string]> = [];

  function record(node: ts.Node, specifier: string, kind: ImportKind, typeOnly: boolean, symbols: ImportedSymbol[]): void {
    const reference = resolvePackageReference(specifier, context);
    if (!reference) return;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const item: ImportRecord = {
      filePath: path,
      specifier,
      packageName: reference.packageName,
      kind,
      typeOnly,
      symbols,
      members: [],
      line: line + 1,
      column: character + 1,
      appearsUnused: false,
    };
    if (reference.subpath !== undefined) item.subpath = reference.subpath;
    records.push(item);
  }

  function handleImport(node: ts.ImportDeclaration, specifier: string): void {
    const clause = node.importClause;
    const clauseTypeOnly = clause?.isTypeOnly === true;
    const symbols: ImportedSymbol[] = [];
    if (clause?.name) symbols.push(symbol('default', clause.name.text, clauseTypeOnly));
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      symbols.push(symbol('*', bindings.name.text, clauseTypeOnly));
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        symbols.push(
          symbol((element.propertyName ?? element.name).text, element.name.text, clauseTypeOnly || element.isTypeOnly),
        );
      }
    }
    const typeOnly = clauseTypeOnly || (symbols.length > 0 && symbols.every((item) => item.typeOnly));
    record(node, specifier, 'static', typeOnly, symbols);
  }

  function handleExportFrom(node: ts.ExportDeclaration, specifier: string): void {
    const clause = node.exportClause;
    const symbols: ImportedSymbol[] = [];
    if (!clause || ts.isNamespaceExport(clause)) {
      symbols.push(symbol('*', undefined, node.isTypeOnly));
    } else {
      for (const element of clause.elements) {
        symbols.push(symbol((element.propertyName ?? element.name).text, undefined, node.isTypeOnly || element.isTypeOnly));
      }
    }
    record(node, specifier, 'export-from', node.isTypeOnly, symbols);
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      handleImport(node, node.moduleSpecifier.text);
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      handleExportFrom(node, node.moduleSpecifier.text);
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      record(node, node.moduleReference.expression.text, 'import-equals', node.isTypeOnly, [
        symbol('*', node.name.text, node.isTypeOnly),
      ]);
      return;
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const call = moduleCall(node.initializer);
      if (call) {
        record(node, call.specifier, call.kind, false, symbolsFromBinding(node.name));
        return;
      }
    }
    if (ts.isCallExpression(node)) {
      const call = moduleCall(node);
      if (call) {
        const parent = node.parent;
        const symbols =
          ts.isPropertyAccessExpression(parent) && parent.expression === node
            ? [symbol(parent.name.text, undefined, false)]
            : [];
        record(node, call.specifier, call.kind, false, symbols);
        return;
      }
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      const symbols = node.qualifier ? [symbol(leftmost(node.qualifier), undefined, true)] : [];
      record(node, node.argument.literal.text, 'dynamic', true, symbols);
    }
    if (ts.isIdentifier(node)) {
      identifierCounts.set(node.text, (identifierCounts.get(node.text) ?? 0) + 1);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      memberAccesses.push([node.expression.text, node.name.text]);
    }
    ts.forEachChild(node, visit);
  }

  try {
    visit(sourceFile);
  } catch (error) {
    if (error instanceof RangeError) return { imports: [], error: 'The file is too deeply nested to analyze.' };
    throw error;
  }

  for (const item of records) {
    const locals = item.symbols.flatMap((entry) => (entry.local === undefined ? [] : [entry.local]));
    item.appearsUnused = locals.length > 0 && locals.every((name) => !identifierCounts.has(name));

    const objectNames = new Set(
      item.symbols
        .filter((entry) => (entry.imported === 'default' || entry.imported === '*') && entry.local !== undefined)
        .map((entry) => entry.local as string),
    );
    if (objectNames.size > 0) {
      const seen = new Set<string>();
      for (const [objectName, member] of memberAccesses) {
        if (objectNames.has(objectName) && !seen.has(member)) {
          seen.add(member);
          item.members.push(member);
        }
      }
    }
  }

  return { imports: records };
}
