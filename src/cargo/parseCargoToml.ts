import {
  CargoDependency,
  CargoParseResult,
  DependencyKind,
  DependencySection,
  TextPoint,
  TextSpan,
} from './types.js';

const DISABLE_MARKER = /#.*(?:dependency-checker|crates)\s*:\s*disable-check/;
const BARE_KEY = /[A-Za-z0-9_-]/;

interface Section {
  kind: DependencySection | 'other';
  dependencyName?: string;
}

interface ParsedString {
  text: string;
  contentSpan: TextSpan;
  after: TextPoint;
}

interface InlineFields {
  version?: ParsedString;
  path: boolean;
  git: boolean;
  workspace: boolean;
  packageName?: string;
  features?: string[];
  defaultFeatures?: boolean;
}

type ParsedValue =
  | ({ type: 'string' } & ParsedString)
  | { type: 'bool'; value: boolean; after: TextPoint }
  | { type: 'strings'; values: string[]; after: TextPoint }
  | { type: 'inline'; fields: InlineFields; after: TextPoint }
  | { type: 'other'; after: TextPoint };

interface Assignment {
  key: string[];
  value: ParsedValue;
  start: TextPoint;
  end: TextPoint;
  startLine: number;
  endLine: number;
}

interface MutableDependency {
  name: string;
  crateName: string;
  section: DependencySection;
  requirement?: string;
  requirementSpan?: TextSpan;
  anchor: TextSpan;
  span: TextSpan;
  path: boolean;
  git: boolean;
  workspace: boolean;
  features: string[];
  defaultFeatures: boolean;
  defaultFeaturesSpecified: boolean;
  markerStartLine: number;
  markerEndLine: number;
}

/** Cargo.toml 텍스트에서 의존성 선언을 읽습니다. */
export function parseCargoToml(text: string): CargoParseResult {
  return new CargoTomlParser(text).parse();
}

class CargoTomlParser {
  private readonly lines: string[];
  private line = 0;
  private col = 0;
  private workspaceManifest = false;

  constructor(text: string) {
    this.lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  }

  parse(): CargoParseResult {
    const bucket = new Map<string, MutableDependency>();
    const dependencies: CargoDependency[] = [];
    let section: Section = { kind: 'other' };

    while (!this.eof) {
      this.skipIgnorable(true);
      if (this.eof) {
        break;
      }
      if (this.peek() === '[') {
        this.flush(bucket, dependencies);
        const headerLine = this.line;
        section = this.parseHeader();
        if (section.kind !== 'other' && section.dependencyName) {
          this.seedNamedDependency(bucket, section.kind, section.dependencyName, headerLine);
        }
        continue;
      }

      const before = this.offset();
      const assignment = this.parseAssignment();
      if (!assignment || this.offset() <= before) {
        this.recover();
        continue;
      }
      if (section.kind !== 'other') {
        this.applyAssignment(bucket, section.kind, section.dependencyName, assignment);
      }
    }

    this.flush(bucket, dependencies);
    return { dependencies, workspaceManifest: this.workspaceManifest };
  }

  private get eof(): boolean {
    return this.line >= this.lines.length;
  }

  private get currentLine(): string {
    return this.lines[this.line] ?? '';
  }

  private peek(): string {
    return this.currentLine[this.col] ?? '';
  }

  private position(): TextPoint {
    return { line: this.line, character: this.col };
  }

  private offset(): number {
    return this.line * 100000 + this.col;
  }

  private advance(): string {
    const ch = this.peek();
    if (!ch) {
      return '';
    }
    this.col += 1;
    return ch;
  }

  private advanceLine(): void {
    this.line += 1;
    this.col = 0;
  }

  private recover(): void {
    if (this.peek()) {
      this.advanceLine();
      return;
    }
    this.advanceLine();
  }

  private skipSameLineSpaces(): void {
    while (this.peek() === ' ' || this.peek() === '\t') {
      this.advance();
    }
  }

  /** 공백과 주석을 넘깁니다. stopAtHeader이면 다음 테이블 헤더 앞에서 멈춥니다. */
  private skipIgnorable(stopAtHeader: boolean): void {
    while (!this.eof) {
      const rest = this.currentLine.slice(this.col);
      if (rest.trim() === '') {
        this.advanceLine();
        continue;
      }
      const leading = rest.length - rest.trimStart().length;
      const trimmed = rest.trimStart();
      if (trimmed.startsWith('#')) {
        this.advanceLine();
        continue;
      }
      if (stopAtHeader && trimmed.startsWith('[')) {
        this.col += leading;
        return;
      }
      if (rest[0] === ' ' || rest[0] === '\t') {
        this.col += 1;
        continue;
      }
      break;
    }
  }

  private parseHeader(): Section {
    this.advance();
    if (this.peek() === '[') {
      this.advance();
    }
    const parts = this.parseDottedKey(true);
    if (this.peek() === ']') {
      this.advance();
    }
    if (this.peek() === ']') {
      this.advance();
    }
    return this.classify(parts);
  }

  private classify(parts: string[]): Section {
    if (parts[0] === 'workspace') {
      this.workspaceManifest = true;
    }
    if (parts[0] === 'workspace' && parts[1] === 'dependencies') {
      return { kind: 'workspace.dependencies', dependencyName: parts[2] || undefined };
    }
    const index = parts.findIndex(part =>
      part === 'dependencies' || part === 'dev-dependencies' || part === 'build-dependencies');
    if (index === -1) {
      return { kind: 'other' };
    }
    return {
      kind: parts[index] as DependencySection,
      dependencyName: parts[index + 1] || undefined,
    };
  }

  private parseAssignment(): Assignment | undefined {
    const start = this.position();
    const startLine = this.line;
    const key = this.parseDottedKey(false).filter(part => part.length > 0);
    if (key.length === 0) {
      return undefined;
    }
    this.skipIgnorable(true);
    if (this.peek() !== '=') {
      return undefined;
    }
    this.advance();
    const value = this.parseValue();
    return {
      key,
      value,
      start,
      end: value.after,
      startLine,
      endLine: value.after.line,
    };
  }

  private parseDottedKey(stopBeforeBracket: boolean): string[] {
    const parts: string[] = [];
    while (!this.eof) {
      this.skipSameLineSpaces();
      if (stopBeforeBracket && (this.peek() === ']' || this.peek() === '')) {
        break;
      }
      let part = '';
      if (this.peek() === '"' || this.peek() === '\'') {
        part = this.parseString()?.text ?? '';
      } else {
        const start = this.offset();
        part = this.parseBare();
        if (this.offset() === start) {
          break;
        }
      }
      parts.push(part);
      this.skipSameLineSpaces();
      if (this.peek() === '.') {
        this.advance();
        continue;
      }
      break;
    }
    return parts;
  }

  private parseBare(): string {
    let text = '';
    while (BARE_KEY.test(this.peek())) {
      text += this.advance();
    }
    return text;
  }

  private parseValue(): ParsedValue {
    this.skipIgnorable(true);
    const ch = this.peek();
    if (ch === '"' || ch === '\'') {
      const parsed = this.parseString();
      if (!parsed) {
        return { type: 'other', after: this.position() };
      }
      return { type: 'string', ...parsed };
    }
    if (ch === '{') {
      const fields = this.parseInlineTable();
      return { type: 'inline', fields: fields.fields, after: fields.after };
    }
    if (ch === '[') {
      const parsed = this.parseArray();
      return { type: 'strings', values: parsed.values, after: parsed.after };
    }
    if (this.consumeLiteral('true')) {
      return { type: 'bool', value: true, after: this.position() };
    }
    if (this.consumeLiteral('false')) {
      return { type: 'bool', value: false, after: this.position() };
    }
    this.consumeBareToken();
    return { type: 'other', after: this.position() };
  }

  private parseInlineTable(): { fields: InlineFields; after: TextPoint } {
    this.advance();
    const fields = emptyFields();
    while (!this.eof) {
      this.skipIgnorable(true);
      const ch = this.peek();
      if (ch === '}') {
        this.advance();
        break;
      }
      if (ch === '[' || ch === ']' || !ch) {
        break;
      }
      const before = this.offset();
      const key = this.parseDottedKey(false);
      this.skipIgnorable(true);
      if (this.peek() !== '=') {
        if (this.offset() <= before) {
          this.recover();
        }
        break;
      }
      this.advance();
      const value = this.parseValue();
      if (this.offset() <= before) {
        this.recover();
        break;
      }
      const field = key[key.length - 1];
      if (field) {
        assignField(fields, field, value);
      }
      this.skipIgnorable(true);
      if (this.peek() === ',') {
        this.advance();
      }
    }
    return { fields, after: this.position() };
  }

  private parseArray(): { values: string[]; after: TextPoint } {
    this.advance();
    const values: string[] = [];
    while (!this.eof) {
      this.skipIgnorable(false);
      const ch = this.peek();
      if (ch === ']' || !ch) {
        if (ch === ']') {
          this.advance();
        }
        break;
      }
      const before = this.offset();
      if (ch === '"' || ch === '\'') {
        const parsed = this.parseString();
        if (parsed) {
          values.push(parsed.text);
        }
      } else if (ch === '{' || ch === '[') {
        const open = ch;
        const close = ch === '{' ? '}' : ']';
        this.advance();
        this.skipBalanced(open, close);
      } else {
        this.consumeBareToken();
      }
      if (this.offset() <= before) {
        this.recover();
        break;
      }
      this.skipIgnorable(false);
      if (this.peek() === ',') {
        this.advance();
      }
    }
    return { values, after: this.position() };
  }

  private parseString(): ParsedString | undefined {
    const quote = this.peek();
    if (quote !== '"' && quote !== '\'') {
      return undefined;
    }
    if (this.currentLine.startsWith(quote.repeat(3), this.col)) {
      return this.parseMultilineString(quote);
    }
    this.advance();
    const contentStart = this.position();
    let text = '';
    while (!this.eof) {
      const ch = this.peek();
      if (!ch) {
        break;
      }
      if (ch === quote) {
        const contentEnd = this.position();
        this.advance();
        return {
          text,
          contentSpan: { start: contentStart, end: contentEnd },
          after: this.position(),
        };
      }
      if (quote === '"' && ch === '\\') {
        text += this.readEscape();
        continue;
      }
      text += this.advance();
    }
    const end = this.position();
    return { text, contentSpan: { start: contentStart, end }, after: end };
  }

  private parseMultilineString(quote: string): ParsedString {
    this.col += 3;
    if (this.peek() === '') {
      this.advanceLine();
    }
    const contentStart = this.position();
    let text = '';
    const delimiter = quote.repeat(3);
    while (!this.eof) {
      if (this.currentLine.startsWith(delimiter, this.col)) {
        const contentEnd = this.position();
        this.col += 3;
        return {
          text,
          contentSpan: { start: contentStart, end: contentEnd },
          after: this.position(),
        };
      }
      if (this.peek() === '') {
        text += '\n';
        this.advanceLine();
        continue;
      }
      if (quote === '"' && this.peek() === '\\') {
        text += this.readEscape();
        continue;
      }
      text += this.advance();
    }
    const end = this.position();
    return { text, contentSpan: { start: contentStart, end }, after: end };
  }

  private readEscape(): string {
    this.advance();
    const ch = this.peek();
    if (!ch) {
      this.advanceLine();
      this.skipSameLineSpaces();
      return '';
    }
    if (ch === 'u') {
      this.advance();
      return this.readUnicodeEscape();
    }
    this.advance();
    switch (ch) {
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case '"':
        return '"';
      case '\\':
        return '\\';
      default:
        return ch;
    }
  }

  private readUnicodeEscape(): string {
    let hex = '';
    if (this.peek() === '{') {
      this.advance();
      while (/[0-9A-Fa-f]/.test(this.peek())) {
        hex += this.advance();
      }
      if (this.peek() === '}') {
        this.advance();
      }
    } else {
      for (let index = 0; index < 4; index += 1) {
        if (!/[0-9A-Fa-f]/.test(this.peek())) {
          break;
        }
        hex += this.advance();
      }
    }
    const code = Number.parseInt(hex, 16);
    if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) {
      return '';
    }
    return String.fromCodePoint(code);
  }

  private consumeLiteral(word: string): boolean {
    if (!this.currentLine.startsWith(word, this.col)) {
      return false;
    }
    const next = this.currentLine[this.col + word.length] ?? '';
    if (BARE_KEY.test(next)) {
      return false;
    }
    this.col += word.length;
    return true;
  }

  private consumeBareToken(): void {
    while (!this.eof) {
      const ch = this.peek();
      if (!ch || /[\s#,{}[\]]/.test(ch)) {
        break;
      }
      this.advance();
    }
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 1;
    while (!this.eof && depth > 0) {
      const ch = this.peek();
      if (!ch) {
        this.advanceLine();
        continue;
      }
      if (ch === '"' || ch === '\'') {
        this.parseString();
        continue;
      }
      if (ch === open) {
        depth += 1;
      } else if (ch === close) {
        depth -= 1;
      }
      this.advance();
    }
  }

  private seedNamedDependency(
    bucket: Map<string, MutableDependency>,
    section: DependencySection,
    name: string,
    headerLine: number,
  ): void {
    const end = this.lines[headerLine]?.length ?? 0;
    const start = { line: headerLine, character: 0 };
    const headerEnd = { line: headerLine, character: end };
    bucket.set(name, {
      name,
      crateName: name,
      section,
      anchor: pointSpan(headerEnd),
      span: { start, end: headerEnd },
      path: false,
      git: false,
      workspace: false,
      features: [],
      defaultFeatures: true,
      defaultFeaturesSpecified: false,
      markerStartLine: headerLine,
      markerEndLine: headerLine,
    });
  }

  private applyAssignment(
    bucket: Map<string, MutableDependency>,
    section: DependencySection,
    dependencyName: string | undefined,
    assignment: Assignment,
  ): void {
    if (dependencyName) {
      const dep = bucket.get(dependencyName) ?? this.createDep(dependencyName, section, assignment);
      const field = assignment.key[0];
      if (field) {
        applyField(dep, field, assignment.value);
      }
      extendDep(dep, assignment);
      bucket.set(dependencyName, dep);
      return;
    }

    const name = assignment.key[0];
    if (!name) {
      return;
    }
    if (assignment.key.length > 1) {
      const field = assignment.key[assignment.key.length - 1];
      const dep = bucket.get(name) ?? this.createDep(name, section, assignment);
      if (field) {
        applyField(dep, field, assignment.value);
      }
      extendDep(dep, assignment);
      bucket.set(name, dep);
      return;
    }

    if (assignment.value.type === 'string' || assignment.value.type === 'inline') {
      const dep = this.createDep(name, section, assignment);
      applyWholeValue(dep, assignment.value);
      bucket.set(name, dep);
    }
  }

  private createDep(name: string, section: DependencySection, assignment: Assignment): MutableDependency {
    return {
      name,
      crateName: name,
      section,
      anchor: pointSpan(assignment.end),
      span: { start: assignment.start, end: assignment.end },
      path: false,
      git: false,
      workspace: false,
      features: [],
      defaultFeatures: true,
      defaultFeaturesSpecified: false,
      markerStartLine: assignment.startLine,
      markerEndLine: assignment.endLine,
    };
  }

  private flush(bucket: Map<string, MutableDependency>, output: CargoDependency[]): void {
    for (const dep of bucket.values()) {
      const finalized = this.finalize(dep);
      if (finalized) {
        output.push(finalized);
      }
    }
    bucket.clear();
  }

  private finalize(dep: MutableDependency): CargoDependency | undefined {
    const kind = dependencyKind(dep);
    if (!kind) {
      return undefined;
    }
    return {
      name: dep.name,
      crateName: dep.crateName,
      requirement: dep.requirement,
      requirementSpan: dep.requirementSpan,
      anchor: dep.anchor,
      span: dep.span,
      kind,
      section: dep.section,
      skipped: this.hasDisableMarker(dep.markerStartLine, dep.markerEndLine),
      features: dep.features,
      defaultFeatures: dep.defaultFeatures,
      defaultFeaturesSpecified: dep.defaultFeaturesSpecified,
    };
  }

  private hasDisableMarker(startLine: number, endLine: number): boolean {
    const first = Math.max(0, Math.min(startLine, endLine));
    const last = Math.min(this.lines.length - 1, Math.max(startLine, endLine));
    for (let line = first; line <= last; line += 1) {
      const withoutStrings = (this.lines[line] ?? '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '');
      if (DISABLE_MARKER.test(withoutStrings)) {
        return true;
      }
    }
    return false;
  }
}

function emptyFields(): InlineFields {
  return { path: false, git: false, workspace: false };
}

function pointSpan(point: TextPoint): TextSpan {
  return { start: point, end: point };
}

function assignField(fields: InlineFields, field: string, value: ParsedValue): void {
  if (field === 'version' && value.type === 'string') {
    fields.version = value;
  } else if (field === 'path' && value.type === 'string') {
    fields.path = true;
  } else if (field === 'git' && value.type === 'string') {
    fields.git = true;
  } else if (field === 'workspace' && value.type === 'bool') {
    fields.workspace = value.value;
  } else if (field === 'package' && value.type === 'string' && value.text) {
    fields.packageName = value.text;
  } else if (field === 'features' && value.type === 'strings') {
    fields.features = value.values;
  } else if ((field === 'default-features' || field === 'default_features') && value.type === 'bool') {
    fields.defaultFeatures = value.value;
  }
}

function applyField(dep: MutableDependency, field: string, value: ParsedValue): void {
  if (field === 'version' && value.type === 'string') {
    dep.requirement = value.text;
    dep.requirementSpan = value.contentSpan;
    dep.anchor = pointSpan(value.after);
  } else if (field === 'path' && value.type === 'string') {
    dep.path = true;
  } else if (field === 'git' && value.type === 'string') {
    dep.git = true;
  } else if (field === 'workspace' && value.type === 'bool' && value.value) {
    dep.workspace = true;
    if (!dep.requirement) {
      dep.anchor = pointSpan(value.after);
    }
  } else if (field === 'package' && value.type === 'string' && value.text) {
    dep.crateName = value.text;
  } else if (field === 'features' && value.type === 'strings') {
    dep.features = value.values;
  } else if ((field === 'default-features' || field === 'default_features') && value.type === 'bool') {
    dep.defaultFeatures = value.value;
    dep.defaultFeaturesSpecified = true;
  }
}

function applyWholeValue(dep: MutableDependency, value: ParsedValue): void {
  if (value.type === 'string') {
    dep.requirement = value.text;
    dep.requirementSpan = value.contentSpan;
    dep.anchor = pointSpan(value.after);
    return;
  }
  if (value.type !== 'inline') {
    return;
  }
  const fields = value.fields;
  if (fields.version) {
    dep.requirement = fields.version.text;
    dep.requirementSpan = fields.version.contentSpan;
  }
  dep.anchor = pointSpan(value.after);
  dep.path = fields.path;
  dep.git = fields.git;
  dep.workspace = fields.workspace;
  if (fields.packageName) {
    dep.crateName = fields.packageName;
  }
  if (fields.features !== undefined) {
    dep.features = fields.features;
  }
  if (fields.defaultFeatures !== undefined) {
    dep.defaultFeatures = fields.defaultFeatures;
    dep.defaultFeaturesSpecified = true;
  }
}

function extendDep(dep: MutableDependency, assignment: Assignment): void {
  if (comparePoint(assignment.start, dep.span.start) < 0) {
    dep.span = { start: assignment.start, end: dep.span.end };
  }
  if (comparePoint(assignment.end, dep.span.end) > 0) {
    dep.span = { start: dep.span.start, end: assignment.end };
  }
  dep.markerStartLine = Math.min(dep.markerStartLine, assignment.startLine);
  dep.markerEndLine = Math.max(dep.markerEndLine, assignment.endLine);
}

function comparePoint(left: TextPoint, right: TextPoint): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.character - right.character;
}

function dependencyKind(dep: MutableDependency): DependencyKind | undefined {
  if (dep.workspace) {
    return 'workspace';
  }
  if (dep.requirement !== undefined) {
    return 'registry';
  }
  if (dep.git) {
    return 'git';
  }
  if (dep.path) {
    return 'path';
  }
  return undefined;
}
