import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { lookupCrate, clearCrateCache, getCachedCrate } from '../crates/sparseIndex.js';
import { judgeRequirement } from '../semver/cargoRequirement.js';
import { compareCrateFeatures } from './features.js';
import { parseCargoToml } from './parseCargoToml.js';
import { CargoDependency, DependencySection, TextSpan } from './types.js';
import { findWorkspaceManifest, resolveInheritedRequirements } from './workspace.js';

const DEFAULT_INDEX_URL = 'https://index.crates.io';

type AnalysisStatus =
  | 'upToDate'
  | 'updateAvailable'
  | 'unparsed'
  | 'loading'
  | 'error'
  | 'notFound'
  | 'unresolvedWorkspace'
  | 'local'
  | 'skipped';

interface ResolvedDependency extends CargoDependency {
  editUri?: vscode.Uri;
}

interface AnalyzedDependency extends ResolvedDependency {
  status: AnalysisStatus;
  latest?: string;
  latestInRange?: string;
  message?: string;
  /** 현재 받을 버전에 있지만 아직 켜지 않은 features */
  availableFeatures?: string[];
  /** 이미 켜지는 features */
  enabledFeatures?: string[];
  /** 최신 버전에만 있는 features */
  addedFeatures?: string[];
}

interface CheckerSettings {
  listPreReleases: boolean;
  indexUrl: string;
}

const cargoTomlSelector: vscode.DocumentSelector = [
  { language: 'toml', pattern: '**/{Cargo,cargo}.toml' },
  { scheme: 'file', pattern: '**/{Cargo,cargo}.toml' },
  { scheme: 'untitled', pattern: '**/{Cargo,cargo}.toml' },
];

/** Cargo.toml을 감시하고 최신 크레이트 버전을 에디터에 표시합니다. */
export class CargoTomlChecker implements vscode.HoverProvider, vscode.CodeActionProvider {
  private readonly upToDateType = vscode.window.createTextEditorDecorationType({});
  private readonly outdatedType = vscode.window.createTextEditorDecorationType({});
  private readonly mutedType = vscode.window.createTextEditorDecorationType({});
  private readonly results = new Map<string, AnalyzedDependency[]>();
  private readonly generation = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.upToDateType,
      this.outdatedType,
      this.mutedType,
      vscode.workspace.onDidOpenTextDocument(document => {
        if (isCargoToml(document)) {
          this.schedule(document);
        }
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (isCargoToml(event.document)) {
          this.refreshVisible();
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.refreshVisible();
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        this.onConfigurationChanged(event);
      }),
      vscode.languages.registerHoverProvider(cargoTomlSelector, this),
      vscode.languages.registerCodeActionsProvider(cargoTomlSelector, this, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
      vscode.commands.registerCommand('dependencyChecker.refresh', () => {
        this.refreshAll();
      }),
      {
        dispose: () => {
          for (const timer of this.timers.values()) {
            clearTimeout(timer);
          }
          this.timers.clear();
        },
      },
    );
    this.refreshVisible();
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const dependency = this.findAt(document, position);
    if (!dependency) {
      return undefined;
    }
    const markdown = new vscode.MarkdownString(buildMarkdown(dependency));
    markdown.isTrusted = false;
    return new vscode.Hover(markdown, toRange(dependency.span));
  }

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): vscode.CodeAction[] {
    const dependency = this.findAt(document, range.start) ?? this.findAt(document, range.end);
    if (!dependency?.latest || !dependency.requirementSpan || !dependency.editUri) {
      return [];
    }
    if (dependency.status !== 'updateAvailable') {
      return [];
    }
    if (dependency.requirement === dependency.latest || !/^[\w.+-]+$/.test(dependency.latest)) {
      return [];
    }

    const editRange = toRange(dependency.requirementSpan);
    if (dependency.editUri.toString() === document.uri.toString()) {
      if (document.getText(editRange) !== dependency.requirement) {
        return [];
      }
    }

    const action = new vscode.CodeAction(
      `최신 버전 ${dependency.latest}로 바꾸기`,
      vscode.CodeActionKind.QuickFix,
    );
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(dependency.editUri, editRange, dependency.latest);
    action.isPreferred = true;
    return [action];
  }

  private onConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
    if (!event.affectsConfiguration('dependencyChecker')) {
      return;
    }
    if (event.affectsConfiguration('dependencyChecker.indexUrl')) {
      clearCrateCache();
    }
    this.refreshVisible();
  }

  private refreshAll(): void {
    clearCrateCache();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    const targets = vscode.window.visibleTextEditors.filter(editor => isCargoToml(editor.document));
    if (targets.length === 0) {
      vscode.window.showInformationMessage('열려 있는 Cargo.toml이 없습니다.');
      return;
    }
    for (const editor of targets) {
      void this.update(editor.document);
    }
  }

  private refreshVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (isCargoToml(editor.document)) {
        this.schedule(editor.document);
      }
    }
  }

  private schedule(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const previous = this.timers.get(key);
    if (previous) {
      clearTimeout(previous);
    }
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.update(document);
    }, 300));
  }

  private async update(document: vscode.TextDocument): Promise<void> {
    if (!isCargoToml(document)) {
      return;
    }
    const key = document.uri.toString();
    const generation = this.nextGeneration(key);
    try {
      const settings = readSettings();
      const dependencies = this.collect(document);
      const preliminary = dependencies.map(dependency => this.analyzeOne(dependency, settings, true));
      if (!this.isCurrent(key, generation)) {
        return;
      }
      this.results.set(key, preliminary);
      this.paint(document, preliminary);

      const names = [...new Set(preliminary.filter(dependency => dependency.status === 'loading').map(dependency => dependency.crateName))];
      await Promise.all(names.map(name => lookupCrate(name, settings.indexUrl)));
      if (!this.isCurrent(key, generation)) {
        return;
      }
      const analyzed = dependencies.map(dependency => this.analyzeOne(dependency, settings, false));
      this.results.set(key, analyzed);
      this.paint(document, analyzed);
    } catch (error) {
      console.error('[dependency-checker]', error);
    }
  }

  private collect(document: vscode.TextDocument): ResolvedDependency[] {
    const parsed = parseCargoToml(document.getText());
    const needsWorkspace = parsed.dependencies.some(dependency => dependency.kind === 'workspace' && !dependency.skipped);
    if (!needsWorkspace) {
      return parsed.dependencies.map(dependency => withEditUri(dependency, document.uri));
    }

    const workspace = this.readWorkspace(document);
    const resolved = resolveInheritedRequirements(parsed.dependencies, workspace.dependencies);
    return resolved.map(dependency => {
      if (dependency.inherited && workspace.uri) {
        return { ...dependency, editUri: workspace.uri };
      }
      return withEditUri(dependency, document.uri);
    });
  }

  private readWorkspace(document: vscode.TextDocument): { uri?: vscode.Uri; dependencies: CargoDependency[] } {
    const own = parseCargoToml(document.getText()).dependencies.filter(dependency => dependency.section === 'workspace.dependencies');
    if (document.uri.scheme !== 'file') {
      return { uri: document.uri, dependencies: own };
    }

    const manifestPath = findWorkspaceManifest(document.uri.fsPath);
    if (!manifestPath) {
      return { dependencies: [] };
    }
    if (pathsEqual(manifestPath, document.uri.fsPath)) {
      return { uri: document.uri, dependencies: own };
    }

    const manifestUri = vscode.Uri.file(manifestPath);
    const open = vscode.workspace.textDocuments.find(item => item.uri.toString() === manifestUri.toString());
    const text = open ? open.getText() : fs.readFileSync(manifestPath, 'utf8');
    return {
      uri: manifestUri,
      dependencies: parseCargoToml(text).dependencies.filter(dependency => dependency.section === 'workspace.dependencies'),
    };
  }

  private analyzeOne(dependency: ResolvedDependency, settings: CheckerSettings, allowLoading: boolean): AnalyzedDependency {
    if (dependency.skipped) {
      return { ...dependency, status: 'skipped' };
    }
    if (dependency.unresolvedWorkspace) {
      return { ...dependency, status: 'unresolvedWorkspace' };
    }
    if (dependency.kind === 'path') {
      return { ...dependency, status: 'local', message: '경로 의존성이라 crates.io 버전을 확인하지 않습니다.' };
    }
    if (dependency.kind === 'git') {
      return { ...dependency, status: 'local', message: 'Git 의존성이라 crates.io 버전을 확인하지 않습니다.' };
    }
    if (dependency.kind !== 'registry') {
      return { ...dependency, status: 'unresolvedWorkspace' };
    }

    const cached = getCachedCrate(dependency.crateName, settings.indexUrl);
    if (!cached) {
      return allowLoading
        ? { ...dependency, status: 'loading' }
        : { ...dependency, status: 'error', message: '버전 정보를 가져오지 못했습니다.' };
    }
    if (cached.type === 'error') {
      return { ...dependency, status: 'error', message: cached.message };
    }
    if (cached.type === 'notFound') {
      return { ...dependency, status: 'notFound' };
    }

    const judgement = judgeRequirement(
      dependency.requirement,
      cached.versions.map(version => version.version),
      settings.listPreReleases,
    );
    if (judgement.status === 'notFound') {
      return { ...dependency, status: 'notFound', message: '사용할 수 있는 버전이 없습니다.' };
    }
    const byVersion = new Map(cached.versions.map(version => [version.version, version]));
    const resolvedVersion = judgement.latestInRange ?? judgement.latest;
    const resolvedEntry = resolvedVersion ? byVersion.get(resolvedVersion) : undefined;
    const latestEntry = judgement.latest ? byVersion.get(judgement.latest) : undefined;
    const featureReport = resolvedEntry
      ? compareCrateFeatures(
        dependency.features,
        dependency.defaultFeatures,
        resolvedEntry.features,
        judgement.latest !== resolvedVersion ? latestEntry?.features : undefined,
      )
      : undefined;
    return {
      ...dependency,
      status: judgement.status,
      latest: judgement.latest,
      latestInRange: judgement.latestInRange,
      availableFeatures: featureReport?.available,
      enabledFeatures: featureReport?.enabled,
      addedFeatures: featureReport?.addedInLatest,
    };
  }

  private paint(document: vscode.TextDocument, dependencies: readonly AnalyzedDependency[]): void {
    const upToDate: vscode.DecorationOptions[] = [];
    const outdated: vscode.DecorationOptions[] = [];
    const muted: vscode.DecorationOptions[] = [];
    for (const dependency of dependencies) {
      const decoration = decorationFor(dependency);
      if (!decoration) {
        continue;
      }
      const option: vscode.DecorationOptions = {
        range: toRange(dependency.anchor),
        renderOptions: {
          after: {
            contentText: ` ${decoration.text}`,
            color: new vscode.ThemeColor(decoration.color),
            margin: '0 0 0 1em',
          },
        },
      };
      if (decoration.bucket === 'upToDate') {
        upToDate.push(option);
      } else if (decoration.bucket === 'outdated') {
        outdated.push(option);
      } else {
        muted.push(option);
      }
    }

    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== document.uri.toString()) {
        continue;
      }
      editor.setDecorations(this.upToDateType, upToDate);
      editor.setDecorations(this.outdatedType, outdated);
      editor.setDecorations(this.mutedType, muted);
    }
  }

  private findAt(document: vscode.TextDocument, position: vscode.Position): AnalyzedDependency | undefined {
    const dependencies = this.results.get(document.uri.toString());
    return dependencies?.find(dependency => positionInSpan(dependency.span, position));
  }

  private nextGeneration(uri: string): number {
    const value = (this.generation.get(uri) ?? 0) + 1;
    this.generation.set(uri, value);
    return value;
  }

  private isCurrent(uri: string, generation: number): boolean {
    return this.generation.get(uri) === generation;
  }
}

function isCargoToml(document: vscode.TextDocument): boolean {
  return path.basename(document.fileName).toLowerCase() === 'cargo.toml';
}

function readSettings(): CheckerSettings {
  const config = vscode.workspace.getConfiguration('dependencyChecker');
  const indexUrl = config.get<string>('indexUrl', DEFAULT_INDEX_URL).trim();
  return {
    listPreReleases: config.get<boolean>('listPreReleases', false),
    indexUrl: indexUrl || DEFAULT_INDEX_URL,
  };
}

function withEditUri(dependency: CargoDependency, uri: vscode.Uri): ResolvedDependency {
  return {
    ...dependency,
    editUri: dependency.requirementSpan ? uri : undefined,
  };
}

function pathsEqual(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function toRange(span: TextSpan): vscode.Range {
  return new vscode.Range(span.start.line, span.start.character, span.end.line, span.end.character);
}

function positionInSpan(span: TextSpan, position: vscode.Position): boolean {
  const range = toRange(span);
  if (range.isEmpty) {
    return range.start.isEqual(position);
  }
  return range.contains(position) || range.end.isEqual(position);
}

function decorationFor(dependency: AnalyzedDependency): { bucket: 'upToDate' | 'outdated' | 'muted'; text: string; color: string } | undefined {
  switch (dependency.status) {
    case 'upToDate':
      return dependency.latest
        ? { bucket: 'upToDate', text: withFeatureHint(`✅ ${dependency.latest}`, dependency), color: 'dependencyChecker.upToDate' }
        : undefined;
    case 'updateAvailable':
      return dependency.latest
        ? { bucket: 'outdated', text: withFeatureHint(`❌ ${dependency.latest}`, dependency), color: 'dependencyChecker.updateAvailable' }
        : undefined;
    case 'unparsed':
      return dependency.latest
        ? { bucket: 'muted', text: withFeatureHint(`최신 ${dependency.latest}`, dependency), color: 'dependencyChecker.muted' }
        : undefined;
    case 'loading':
      return { bucket: 'muted', text: '조회 중', color: 'dependencyChecker.muted' };
    case 'error':
      return { bucket: 'muted', text: '조회 실패', color: 'dependencyChecker.muted' };
    case 'notFound':
      return { bucket: 'muted', text: '없음', color: 'dependencyChecker.muted' };
    case 'unresolvedWorkspace':
      return { bucket: 'muted', text: '워크스페이스에 없음', color: 'dependencyChecker.muted' };
    default:
      return undefined;
  }
}

function buildMarkdown(dependency: AnalyzedDependency): string {
  const lines: string[] = [];
  lines.push(dependency.latest ? `**${dependency.crateName}** \`${dependency.latest}\`` : `**${dependency.crateName}**`);
  lines.push(sectionLabel(dependency.section));
  if (dependency.name !== dependency.crateName) {
    lines.push(`매니페스트 이름: \`${dependency.name}\``);
  }
  if (dependency.requirement) {
    lines.push(`요구 버전: \`${dependency.requirement}\``);
  }
  lines.push(statusText(dependency));
  if (dependency.status === 'updateAvailable' && dependency.latestInRange) {
    lines.push(`이 범위에서 받을 수 있는 최신 버전은 \`${dependency.latestInRange}\`입니다.`);
  }
  if (dependency.enabledFeatures && dependency.enabledFeatures.length > 0) {
    lines.push(`켜진 features: ${formatFeatureList(dependency.enabledFeatures)}`);
  }
  if (dependency.availableFeatures && dependency.availableFeatures.length > 0) {
    lines.push(`켜지지 않은 features: ${formatFeatureList(dependency.availableFeatures)}`);
  }
  if (dependency.addedFeatures && dependency.addedFeatures.length > 0 && dependency.latest) {
    lines.push(`최신 ${dependency.latest}에만 있는 features: ${formatFeatureList(dependency.addedFeatures)}`);
  }
  if (dependency.kind === 'registry' || dependency.latest) {
    const crate = encodeURIComponent(dependency.crateName);
    const docs = dependency.latest
      ? `https://docs.rs/${crate}/${encodeURIComponent(dependency.latest)}`
      : `https://docs.rs/${crate}`;
    lines.push(`[crates.io](https://crates.io/crates/${crate}) · [docs.rs](${docs})`);
  }
  return lines.join('\n\n');
}

function statusText(dependency: AnalyzedDependency): string {
  switch (dependency.status) {
    case 'upToDate':
      return '요구 범위에 최신 버전이 포함됩니다.';
    case 'updateAvailable':
      return '최신 버전이 요구 범위 밖에 있습니다.';
    case 'unparsed':
      return '요구 버전 형식을 해석하지 못했습니다.';
    case 'loading':
      return '최신 버전을 조회하고 있습니다.';
    case 'error':
      return dependency.message ?? '버전 정보를 가져오지 못했습니다.';
    case 'notFound':
      return dependency.message ?? 'crates.io에서 크레이트를 찾지 못했습니다.';
    case 'unresolvedWorkspace':
      return '워크스페이스 의존성 정의를 찾지 못했습니다.';
    case 'local':
      return dependency.message ?? '레지스트리 의존성이 아닙니다.';
    case 'skipped':
      return '이 줄의 주석으로 버전 검사를 건너뜁니다.';
    default:
      return '';
  }
}

function withFeatureHint(text: string, dependency: AnalyzedDependency): string {
  const hints: string[] = [];
  const available = dependency.availableFeatures?.length ?? 0;
  const added = dependency.addedFeatures?.length ?? 0;
  if (available > 0) {
    hints.push(`features +${available}`);
  }
  if (added > 0) {
    hints.push(`새 features +${added}`);
  }
  if (hints.length === 0) {
    return text;
  }
  return `${text} · ${hints.join(', ')}`;
}

function formatFeatureList(names: readonly string[]): string {
  return names.map(name => `\`${name.replace(/`/g, '')}\``).join(', ');
}

function sectionLabel(section: DependencySection): string {
  switch (section) {
    case 'dependencies':
      return '의존성';
    case 'dev-dependencies':
      return '개발 의존성';
    case 'build-dependencies':
      return '빌드 의존성';
    case 'workspace.dependencies':
      return '워크스페이스 의존성';
    default:
      return '의존성';
  }
}
