// mend applies AI-written edits as specified in SPEC.md (MIT, Node 22).
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function parseError(index: number): never {
  throw new Exit2(`error: parse ${index + 1}`);
}

function readLines(text: string): { lines: string[]; br: string; final: boolean } {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function writeLines(lines: string[], br = '\n', final = true): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

const withoutTrailingSpace = (line: string): string => line.replace(/[ \t]+$/, '');
const indent = (line: string): string => /^[ \t]*/.exec(line)![0];
const withoutIndent = (line: string): string => withoutTrailingSpace(line).slice(indent(line).length);

function matchLines(
  lines: string[], old: string[], strict: boolean, first = 0, last = lines.length - old.length,
): { positions: number[]; tier: number } {
  const normalizers = [(line: string) => line, withoutTrailingSpace, withoutIndent];
  for (let tier = 0; tier < (strict ? 1 : normalizers.length); tier++) {
    const normalize = normalizers[tier]!;
    const target = old.map(normalize);
    const positions: number[] = [];
    for (let at = first; at <= last; at++) {
      if (target.every((line, offset) => line === normalize(lines[at + offset]!))) positions.push(at);
    }
    if (positions.length) return { positions, tier };
  }
  return { positions: [], tier: 0 };
}

type NewLine = { text: string; context?: number; noBreak?: boolean };
type LineChange = { old: string[]; next: NewLine[] };

function readChange(body: string[]): LineChange {
  const old: string[] = [];
  const next: NewLine[] = [];
  let previous: NewLine | undefined;
  for (const line of body) {
    const prefix = line[0] ?? ' ';
    const text = line.slice(1);
    if (prefix === '\\') {
      if (previous !== undefined) previous.noBreak = true;
      previous = undefined;
      continue;
    }
    previous = undefined;
    if (prefix !== '-') {
      previous = prefix === ' ' ? { text, context: old.length } : { text };
      next.push(previous);
    }
    if (prefix !== '+') old.push(text);
  }
  return { old, next };
}

function replacement(lines: string[], at: number, change: LineChange, tier: number): string[] {
  const patchIndent = indent(change.old[0] ?? '');
  return change.next.map(({ text, context }) => {
    if (context !== undefined) return lines[at + context]!;
    if (tier === 2 && !blank(text) && text.startsWith(patchIndent)) {
      return indent(lines[at]!) + text.slice(patchIndent.length);
    }
    return text;
  });
}

function checkPaths(...paths: string[]): void {
  for (const path of paths) if (!safe(path)) throw new Fail('unsafe', path);
}

function requireFile(tree: Tree, path: string): string {
  const before = tree.get(path);
  if (before === null) throw new Fail('missing', path);
  return before;
}

function requireAbsent(tree: Tree, path: string): void {
  if (tree.get(path) !== null) throw new Fail('exists', path);
}

function saveEdit(tree: Tree, from: string, to: string, text: string): void {
  tree.now.set(to, text);
  if (from !== to) {
    tree.now.set(from, null);
    tree.moves.push({ from, to });
  }
}

type Hunk = LineChange & { start: number };
type UnifiedSection = {
  paths: [string | null, string | null];
  headers?: [string | null, string | null];
  rename: [string?, string?];
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
};

function unifiedPath(line: string): string | null {
  const path = line.slice(4).split('\t', 1)[0]!.trim();
  return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
}

function unifiedEdit(section: UnifiedSection, strict: boolean): Edit {
  const [from, to] = section.headers ?? [
    section.rename[0] ?? section.paths[0], section.rename[1] ?? section.paths[1],
  ];
  return (tree) => {
    checkPaths(...[from, to].filter((path): path is string => path !== null));
    if (from === null || section.creation) {
      const path = to ?? '';
      checkPaths(path);
      requireAbsent(tree, path);
      const added = section.hunks.flatMap((hunk) => hunk.next.filter((line) => line.context === undefined));
      tree.now.set(path, writeLines(added.map((line) => line.text), '\n', !added.at(-1)?.noBreak));
      return;
    }
    const before = requireFile(tree, from);
    if (to === null || section.deletion) {
      tree.now.set(from, null);
      return;
    }
    if (from !== to) requireAbsent(tree, to);
    const file = readLines(before);
    let delta = 0;
    for (const hunk of section.hunks) {
      let at = Math.max(0, Math.min(file.lines.length, hunk.start + delta));
      let tier = 0;
      if (hunk.old.length) {
        const match = matchLines(file.lines, hunk.old, strict);
        if (!match.positions.length) throw new Fail('no-match', from);
        tier = match.tier;
        const target = hunk.start - 1 + delta;
        at = match.positions.reduce((best, pos) => Math.abs(pos - target) < Math.abs(best - target) ? pos : best);
      }
      if (at + hunk.old.length === file.lines.length) file.final = !hunk.next.at(-1)?.noBreak;
      const next = replacement(file.lines, at, hunk, tier);
      file.lines.splice(at, hunk.old.length, ...next);
      delta += next.length - hunk.old.length;
    }
    saveEdit(tree, from, to, writeLines(file.lines, file.br, file.final));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | undefined;
  const start = (paths: UnifiedSection['paths']): UnifiedSection => {
    const next: UnifiedSection = { paths, rename: [], creation: false, deletion: false, hunks: [] };
    sections.push(next);
    return next;
  };
  const pair = (i: number): boolean => lines[i]?.startsWith('--- ') && !!lines[i + 1]?.startsWith('+++ ');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const git = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!git) parseError(i);
      section = start([git[1]!, git[2]!]);
    } else if (pair(i)) {
      if (!section || section.headers || section.hunks.length) section = start([null, null]);
      section.headers = [unifiedPath(line), unifiedPath(lines[++i]!)];
    } else if (line.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (!header || !section) parseError(i);
      const first = i + 1;
      let end = first;
      while (end < lines.length && !pair(end) && /^(?:[ +\\-]|$)/.test(lines[end]!)) end++;
      i = end - 1;
      while (end > first && lines[end - 1] === '') end--;
      section.hunks.push({ start: Number(header[1]), ...readChange(lines.slice(first, end)) });
    } else if (section && !section.hunks.length) {
      if (line.startsWith('--- ')) parseError(i + 1);
      if (line.startsWith('rename from ')) section.rename[0] = line.slice(12);
      if (line.startsWith('rename to ')) section.rename[1] = line.slice(10);
      if (line.startsWith('new file mode')) section.creation = true;
      if (line.startsWith('deleted file mode')) section.deletion = true;
    }
  }
  return sections.map((part) => unifiedEdit(part, strict));
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousPath: string | undefined;
  let candidate: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimEnd();
    if (line !== '<<<<<<< SEARCH') {
      const path = line.trimStart();
      if (path && !path.startsWith('```')) candidate = path;
      continue;
    }
    const path = candidate ?? previousPath;
    if (path === undefined) parseError(i);
    let middle = i + 1;
    while (middle < lines.length && lines[middle]!.trimEnd() !== '=======') middle++;
    let end = middle + 1;
    while (end < lines.length && lines[end]!.trimEnd() !== '>>>>>>> REPLACE') end++;
    if (end >= lines.length) parseError(i);
    const change: LineChange = {
      old: lines.slice(i + 1, middle),
      next: lines.slice(middle + 1, end).map((text) => ({ text })),
    };
    edits.push((tree) => {
      checkPaths(path);
      if (!change.old.length) {
        requireAbsent(tree, path);
        tree.now.set(path, writeLines(change.next.map((line) => line.text)));
        return;
      }
      const file = readLines(requireFile(tree, path));
      const { positions, tier } = matchLines(file.lines, change.old, strict);
      if (!positions.length) throw new Fail('no-match', path);
      if (positions.length > 1) throw new Fail('ambiguous', path);
      const at = positions[0]!;
      file.lines.splice(at, change.old.length, ...replacement(file.lines, at, change, tier));
      tree.now.set(path, writeLines(file.lines, file.br, file.final));
    });
    i = end;
    previousPath = path;
    candidate = undefined;
  }
  return edits;
}

type V4AChunk = LineChange & { anchor: string; atEnd: boolean };

function v4aUpdate(path: string, destination: string | undefined, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree) => {
    const target = destination ?? path;
    checkPaths(path, target);
    const file = readLines(requireFile(tree, path));
    if (destination !== undefined) requireAbsent(tree, destination);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor) {
        const { positions } = matchLines(file.lines, [chunk.anchor], strict, cursor);
        if (!positions.length) throw new Fail('no-match', path);
        cursor = positions[0]! + 1;
      }
      const last = file.lines.length - chunk.old.length;
      let at = chunk.atEnd ? last : cursor;
      let tier = 0;
      if (chunk.old.length) {
        const match = matchLines(file.lines, chunk.old, strict, chunk.atEnd ? Math.max(cursor, last) : cursor, last);
        if (!match.positions.length) throw new Fail('no-match', path);
        at = match.positions[0]!;
        tier = match.tier;
      }
      const next = replacement(file.lines, at, chunk, tier);
      file.lines.splice(at, chunk.old.length, ...next);
      cursor = at + next.length;
    }
    saveEdit(tree, path, target, writeLines(file.lines, file.br, file.final));
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((line) => !blank(line));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') parseError(Math.max(0, first));
  let last = lines.length - 1;
  while (blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') parseError(lines.length);

  const sectionHeader = /^\*\*\* (Add|Delete|Update) File: /;
  const bodyLine = /^(?:[ +\-]|$)/;
  const edits: Edit[] = [];
  for (let i = first + 1; i < last;) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const header = sectionHeader.exec(line);
    if (!header) parseError(i);
    const path = line.slice(header[0].length).trim();
    const sectionLine = i++;
    let next = i;
    while (next < last && !sectionHeader.test(lines[next]!)) next++;
    let end = next;
    while (end > i && blank(lines[end - 1]!)) end--;

    if (header[1] === 'Add') {
      const added: string[] = [];
      for (; i < end; i++) {
        const row = lines[i]!;
        if (row !== '' && !row.startsWith('+')) parseError(i);
        added.push(row.slice(1));
      }
      edits.push((tree) => {
        checkPaths(path);
        requireAbsent(tree, path);
        tree.now.set(path, writeLines(added));
      });
    } else if (header[1] === 'Delete') {
      if (i < end) parseError(i);
      edits.push((tree) => {
        checkPaths(path);
        requireFile(tree, path);
        tree.now.set(path, null);
      });
    } else {
      const move = '*** Move to: ';
      const destination = i < end && lines[i]!.startsWith(move) ? lines[i++]!.slice(move.length).trim() : undefined;
      const chunks: V4AChunk[] = [];
      while (i < end) {
        let anchor = '';
        if (lines[i]!.startsWith('@@')) anchor = lines[i++]!.slice(2).trim();
        else if (chunks.length || !bodyLine.test(lines[i]!)) parseError(i);
        const bodyStart = i;
        while (i < end && bodyLine.test(lines[i]!)) i++;
        const change = readChange(lines.slice(bodyStart, i));
        const atEnd = i < end && lines[i] === '*** End of File';
        if (atEnd) i++;
        chunks.push({ ...change, anchor, atEnd });
      }
      if (!chunks.length && destination === undefined) parseError(sectionLine);
      edits.push(v4aUpdate(path, destination, chunks, strict));
    }
    i = next;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    switch (kind) {
      case 'json': edits = jsonEdits(text, lines); break;
      case 'unified': edits = unifiedEdits(lines, strict); break;
      case 'search-replace': edits = searchReplaceEdits(lines, strict); break;
      case 'v4a': edits = v4aEdits(lines, strict); break;
      default: edits = [];
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.moves.length = moveCount;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: string[] = [];
  const renamed = new Map<string, string>();
  const movedFrom = new Set<string>();
  for (const { from, to } of tree.moves) {
    if (tree.original(from) !== null && tree.get(from) === null &&
        tree.original(to) === null && tree.get(to) !== null &&
        !movedFrom.has(from) && !renamed.has(to)) {
      movedFrom.add(from);
      renamed.set(to, from);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const from = renamed.get(p);
    if (from !== undefined) rows.push(`R ${from} -> ${p}`);
    else if (!movedFrom.has(p)) rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
