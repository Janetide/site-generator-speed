// site-generator-speed: a faster drop-in for makefun-site 1.0.0.
//
// Written from scratch in this session from the makefun-site README's rules and
// the reference's observable behaviour. Same output, byte for byte; faster by
// construction: plain-text runs are escaped in bulk instead of one regex call
// per character, Markdown is lexed and rendered in one fused pass over the
// lines with no per-line regexes, slugs and long dates are cached, and every
// template is compiled once into a plain function instead of being walked as
// a node tree on every page.

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
export function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;
const slugCache = new Map();

/** The slug of `text` (see the README's Text section). Results are cached: the same titles and tag names recur across a site. */
export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifySlow(text);
  if (slugCache.size > 20000) slugCache.clear();
  slugCache.set(text, out);
  return out;
}

function slugifySlow(text) {
  // Pure ASCII: NFKD is the identity and there are no combining marks, so the
  // normalise-and-strip pass can be skipped entirely.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  let out = '';
  let gap = false;
  if (ascii) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone. */
export function longDate(date) {
  let hit = dateCache.get(date);
  if (hit === undefined) {
    const [y, m, d] = date.split('-');
    hit = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
    if (dateCache.size > 5000) dateCache.clear();
    dateCache.set(date, hit);
  }
  return hit;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

/** Whether code unit `c` is JavaScript whitespace (the `\s` set). */
function isWsCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0x00a0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** Whether `s` holds any whitespace. */
function hasWs(s) {
  for (let i = 0; i < s.length; i++) if (isWsCode(s.charCodeAt(i))) return true;
  return false;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether `target` is an absolute or schemed link, kept as written. */
function isKeptLink(target) {
  const c0 = target.charCodeAt(0);
  if (c0 === 47 || c0 === 35) return true; // '/' or '#'
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  let i = 1;
  while (i < target.length) {
    const c = target.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) i++;
    else break;
  }
  return i < target.length && target.charCodeAt(i) === 58;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      let y = 0, mo = 0, d = 0;
      if (ok) { y = +raw.slice(0, 4); mo = +raw.slice(5, 7); d = +raw.slice(8, 10); }
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      const parts = raw.split('-');
      for (const p of parts) {
        if (p.length === 0) return { error: 'key "slug": not a slug' };
        for (let i = 0; i < p.length; i++) {
          const c = p.charCodeAt(i);
          if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) return { error: 'key "slug": not a slug' };
        }
      }
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error }. */
export function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    let j = 0;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if ((c >= 97 && c <= 122) || c === 95) j++;
      else break;
    }
    if (j === 0 || j >= line.length || line.charCodeAt(j) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    let raw;
    if (j + 1 === line.length) raw = '';
    else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    raw = raw.slice(0, e);
    const key = line.slice(0, j);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

/** `s` rendered inline, appended to `out` (an array of chunks). `env.link(target)` is a link's href. */
function inline(s, env, out) {
  const re = /[\\`*\[]/g;
  let i = 0;
  let plain = 0;
  while (true) {
    re.lastIndex = i;
    const m = re.exec(s);
    const j = m === null ? s.length : m.index;
    if (j === s.length) {
      if (s.length > plain) out.push(escapeHtml(s.slice(plain)));
      return;
    }
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
      out.push(escapeHtml(s[j + 1])); // the vendor escapes it too: '>' is escapable and HTML-special
      i = j + 2;
      plain = i;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        plain = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
          out.push('<strong>');
          inline(s.slice(j + 2, k), env, out);
          out.push('</strong>');
          i = k + 2;
          plain = i;
        } else {
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
        out.push('<em>');
        inline(s.slice(j + 1, k), env, out);
        out.push('</em>');
        i = k + 1;
        plain = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', j + 1);
    const n = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = n === -1 ? '' : s.slice(k + 2, n);
    if (target !== '' && !hasWs(target)) {
      if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      inline(s.slice(j + 1, k), env, out);
      out.push('</a>');
      i = n + 1;
      plain = i;
      continue;
    }
    i = j + 1;
  }
}

/** `s` rendered inline, as one string. */
function inlineStr(s, env) {
  const out = [];
  inline(s, env, out);
  return out.join('');
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** The fence language when `line` opens a fence, else null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  for (let j = i; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, i);
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6 || n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** The text after a bullet marker (`- ` or `* `), or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** The start number and text after an ordered marker, or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { start: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isWsCode(line.charCodeAt(i));
}

/**
 * `src` rendered: its HTML, its table of contents (every level 2 and 3 heading)
 * and its excerpt (the first paragraph's inline HTML, or "").
 */
export function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      let code = '';
      for (const l of body) code += escapeHtml(l) + '\n';
      blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inlineStr(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { blocks.push('<hr>'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const inner = body.map(trimLine).filter((l) => l !== '');
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(inner.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) { items.push([trimLine(m.text)]); i++; continue; }
        } else {
          const b = bulletOf(l);
          if (b !== null) { items.push([trimLine(b)]); i++; continue; }
        }
        if (isContinued(l)) { items[items.length - 1].push(trimLine(l)); i++; continue; }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.start !== 1 ? `<ol start="${ordered.start}">` : `<${tag}>`;
      let inner = '';
      for (const parts of items) inner += `<li>${inlineStr(parts.join('\n'), env)}</li>\n`;
      blocks.push(`${open}\n${inner}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/**
 * `source`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line
 * taken with it — the vendor's tokenizer, error for error (an { error } with
 * the vendor's message when it does not parse). A {% %} tag alone on its line
 * (only spaces or tabs beside it) takes its whole line with it, its newline included.
 */
function tokenizeTemplate(source, name) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('{', i);
    if (open === -1 || open === source.length - 1) {
      text += source.slice(i);
      break;
    }
    const next = source[open + 1];
    if (next !== '{' && next !== '%') {
      text += source.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += source.slice(i, open);
    if (next === '{') {
      const raw = source[open + 2] === '{';
      const close = source.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) return { error: `template "${name}": a ${raw ? '{{{' : '{{'} is not closed` };
      const path = source.slice(open + (raw ? 3 : 2), close).trim();
      if (!PATH_RE.test(path)) return { error: `template "${name}": ${JSON.stringify(path)} is not a path` };
      if (text !== '') tokens.push({ kind: 'text', value: text });
      text = '';
      tokens.push({ kind: raw ? 'var-raw' : 'var', path });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = source.indexOf('%}', open + 2);
    if (close === -1) return { error: `template "${name}": a {% is not closed` };
    const end = close + 2;
    const lineStart = source.lastIndexOf('\n', open - 1) + 1;
    const nl = source.indexOf('\n', end);
    const lineEnd = nl === -1 ? source.length : nl;
    const standalone = /^[ \t]*$/.test(source.slice(lineStart, open)) && /^[ \t]*$/.test(source.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ kind: 'text', value: text });
    text = '';
    tokens.push({ kind: 'tag', tag: source.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? source.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ kind: 'text', value: text });
  return tokens;
}

/** A template's nodes from already-lexed tokens, or an { error } when it does not parse. */
function parseTemplateTokens(tokens, name) {
  const out = [];
  const stack = [];
  let node = out;
  for (const t of tokens) {
    if (t.kind === 'text' || t.kind === 'var' || t.kind === 'var-raw') { node.push(t); continue; }
    const tag = t.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      if (!PATH_RE.test(m[2])) return { error: `template "${name}": ${JSON.stringify(m[2])} is not a path` };
      const n = { kind: 'for', item: m[1], path: m[2], body: [] };
      node.push(n);
      stack.push(n);
      node = n.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      if (!PATH_RE.test(m[2])) return { error: `template "${name}": ${JSON.stringify(m[2])} is not a path` };
      const n = { kind: 'if', not: m[1] !== undefined, path: m[2], then: [], else: null };
      node.push(n);
      stack.push(n);
      node = n.then;
    } else if (tag === 'else') {
      if (top === undefined || top.kind !== 'if' || top.else !== null) return { error: `template "${name}": an else outside an if` };
      top.else = [];
      node = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top === undefined || top.kind !== (tag === 'endfor' ? 'for' : 'if')) return { error: `template "${name}": an ${tag} with no open ${tag.slice(3)}` };
      stack.pop();
      const parent = stack[stack.length - 1];
      node = parent === undefined ? out : parent.kind === 'for' ? parent.body : (parent.else ?? parent.then);
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      node.push({ kind: 'include', name: m[1] });
    } else return { error: `template "${name}": {% ${tag} %} is not a tag` };
  }
  if (stack.length > 0) return { error: `template "${name}": a ${stack[stack.length - 1].kind} is not closed` };
  return out;
}

/** A template's nodes, or an { error } when it does not parse. */
function parseTemplateFinal(source, name) {
  const tokens = tokenizeTemplate(source, name);
  if ('error' in tokens) return tokens;
  return parseTemplateTokens(tokens, name);
}

/** A path's names, read from `scope`: the innermost loop binding the first, else the page's values. `parts` is split once, at compile time. */
function getPath(scope, parts) {
  const root = parts[0];
  let base;
  for (let i = scope.length - 1; i >= 0; i--) {
    if (Object.hasOwn(scope[i], root)) { base = scope[i][root]; break; }
  }
  if (base === undefined) return undefined;
  let v = base;
  for (let k = 1; k < parts.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, parts[k])) return undefined;
    v = v[parts[k]];
  }
  return v;
}

/** The text of a value: string itself, a number in JavaScript's digits, true/false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value is true: undefined, null, false, "", 0 and an empty array are false. */
function truthy(v) {
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0 && !(Array.isArray(v) && v.length === 0);
}

/** Whether an if's branch is taken: the value at `path` is true, flipped when `not`. */
function condTrue(scope, path, not) {
  return truthy(getPath(scope, path)) !== not;
}

/** JS source for `nodes`, rendered into `O` in scope `S`. */
function compileNodes(nodes, depth) {
  let js = '';
  for (const n of nodes) {
    if (n.kind === 'text') {
      js += `O.push(${JSON.stringify(n.value)});`;
    } else if (n.kind === 'var') {
      js += `O.push(C.esc(S,${JSON.stringify(n.path.split('.'))}));`;
    } else if (n.kind === 'var-raw') {
      js += `O.push(C.raw(S,${JSON.stringify(n.path.split('.'))}));`;
    } else if (n.kind === 'if') {
      js += `if(C.cond(S,${JSON.stringify(n.path.split('.'))},${n.not ? 'true' : 'false'})){${compileNodes(n.then, depth)}}`;
      if (n.else !== null) js += `else{${compileNodes(n.else, depth)}}`;
    } else if (n.kind === 'for') {
      js += `(()=>{const A=C.get(S,${JSON.stringify(n.path.split('.'))});if(Array.isArray(A)){for(let _i=0;_i<A.length;_i++){const _s=S.slice();_s.push({${JSON.stringify(n.item)}:A[_i],loop:{index:_i+1,first:_i===0,last:_i===A.length-1,length:A.length}});{const S=_s;${compileNodes(n.body, depth + 1)}}}}})();`;
    } else if (n.kind === 'include') {
      js += `if(D<8)O.push(C.render(${JSON.stringify(n.name)},S,D+1));`;
    }
  }
  return js;
}

/** Compiled templates, keyed by name. */
export class TemplateSet {
  constructor(compiled, errors) {
    this.compiled = compiled;
    this.errors = errors;
    // One helper object for every render (layouts include each other thousands of times per case).
    this.C = {
      get: getPath,
      cond: condTrue,
      esc: (s, p) => escapeHtml(textOf(getPath(s, p))),
      raw: (s, p) => textOf(getPath(s, p)),
      render: (n, s, d) => this.render(n, s, d),
    };
  }

  /** Every template's source, parsed and compiled; reports the ones that do not parse. */
  static from(templates) {
    const compiled = new Map();
    const errors = [];
    const names = Object.keys(templates).sort(byCodeUnits);
    for (const name of names) {
      const parsed = parseTemplateFinal(templates[name], name);
      if ('error' in parsed) {
        errors.push(parsed.error);
        continue;
      }
      const body = compileNodes(parsed, 0);
      const fn = new Function('C', 'D', 'S', 'O', body);
      compiled.set(name, fn);
    }
    return new TemplateSet(compiled, errors);
  }

  /** A template's output in `scope`, or "" when it is missing (or too deeply nested). */
  render(name, scope, depth) {
    const fn = this.compiled.get(name);
    if (fn === undefined) return '';
    const out = [];
    fn(this.C, depth, scope, out);
    return out.join('');
  }
}

// ---------------------------------------------------------------- build

/** The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(input) {
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, text: f.content });
  }
  return { sources, statics };
}

/** A source's tags, each slug once, in its own order. */
function ownTagsOf(data) {
  const seen = new Set();
  const out = [];
  for (const t of data.tags ?? []) {
    const slug = slugify(t);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(t);
  }
  return out;
}

/** The text of a built page's card. */
function cardOf(page, ctx) {
  return {
    title: page.data.title,
    url: page.url,
    date: page.data.date ?? '',
    date_long: page.data.date !== undefined ? longDate(page.data.date) : '',
    summary: page.data.summary ?? '',
    excerpt: page.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(page.body) / 200)),
    tags: ownTagsOf(page.data).map((t) => {
      const slug = slugify(t);
      const tag = ctx.tagBySlug.get(slug);
      // A page's tag links to the posts' tag of the same slug, or to nothing (url "") where no post has it.
      return tag === undefined ? { name: t, slug, url: '' } : { name: tag.name, slug: tag.slug, url: tag.url };
    }),
  };
}

/** A built page's values for its layout, plus its slug and content. */
function pageOf(page, ctx) {
  const card = cardOf(page, ctx);
  return {
    ...card,
    slug: page.slug,
    content: page.html,
    toc: page.toc,
    newer: page.newer === null ? null : { title: page.newer.data.title, url: page.newer.url, date: page.newer.data.date ?? '', date_long: page.newer.data.date !== undefined ? longDate(page.newer.data.date) : '' },
    older: page.older === null ? null : { title: page.older.data.title, url: page.older.url, date: page.older.data.date ?? '', date_long: page.older.data.date !== undefined ? longDate(page.older.data.date) : '' },
    is_post: page.isPost,
  };
}

/** `input` built: every path makefun-site 1.0.0 writes, and that file's text. */
export function run(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  const ctx = { base, reports: [], templates: null, tags: [], tagBySlug: new Map() };
  const { sources, statics } = readSources(input);
  const templates = TemplateSet.from(input.templates);
  ctx.templates = templates;
  for (const e of templates.errors) ctx.reports.push(e);

  const pages = [];
  const posts = [];
  const byDir = new Map();
  byDir.set('', new Set(RESERVED));
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { ctx.reports.push(`refused ${s.path}: ${fm.error}`); continue; }
    const isPost = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : null;
    if (own !== null) { ctx.reports.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (isPost && fm.data.date === undefined) { ctx.reports.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = fm.data.layout ?? (isPost ? 'post' : 'page');
    if (!templates.compiled.has(layout)) { ctx.reports.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    if (fm.data.draft === true) { ctx.reports.push(`draft ${s.path}`); continue; }
    const dir = isPost ? 'posts' : dirOf(s.path);
    let set = byDir.get(dir);
    if (set === undefined) { set = new Set(); byDir.set(dir, set); }
    const slug = uniqueSlug(fm.data.slug ?? slugify(fm.data.title), set);
    const page = { ...s, data: fm.data, body: fm.body, dir, isPost, layout, slug, url: `${base}/${dir === '' ? '' : `${dir}/`}${slug}/` };
    pages.push(page);
    if (isPost) posts.push(page);
  }

  posts.sort((a, b) => {
    if (a.data.date !== b.data.date) return a.data.date > b.data.date ? -1 : 1;
    return byCodeUnits(a.slug, b.slug);
  });
  for (let i = 0; i < posts.length; i++) {
    posts[i].newer = i === 0 ? null : posts[i - 1];
    posts[i].older = i === posts.length - 1 ? null : posts[i + 1];
  }
  for (const p of pages) {
    if (!p.isPost) { p.newer = null; p.older = null; }
  }

  // Every page's body, rendered once; its links resolved against the built pages.
  const byPath = new Map();
  for (const p of pages) byPath.set(p.path, p);
  const staticPaths = new Set(statics.map((f) => f.path));
  const linkSeen = new Set();
  const linkOf = (from) => (target) => {
    if (isKeptLink(target)) return target;
    const hash = target.indexOf('#');
    const path = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const resolved = resolvePath(dirOf(from), path);
    if (resolved !== null) {
      const page = byPath.get(resolved);
      if (page !== undefined) return page.url + frag;
      if (staticPaths.has(resolved)) return `${base}/${resolved}${frag}`;
    }
    const key = `${from} -> ${target}`;
    if (!linkSeen.has(key)) { linkSeen.add(key); ctx.reports.push(`broken-link ${from} -> ${target}`); }
    return target;
  };
  for (const p of pages) {
    const r = renderMarkdown(p.body, { link: linkOf(p.path) });
    p.html = r.html;
    p.toc = r.toc;
    p.excerpt = r.excerpt;
  }

  // Tags: each post's tags, each slug once, in its own order.
  const tagList = [];
  for (const p of posts) {
    for (const t of ownTagsOf(p.data)) {
      const slug = slugify(t);
      if (!ctx.tagBySlug.has(slug)) {
        const tag = { name: t, slug, url: `${base}/tags/${slug}/`, count: 0, posts: [] };
        ctx.tagBySlug.set(slug, tag);
        tagList.push(tag);
      }
      ctx.tagBySlug.get(slug).posts.push(p);
    }
  }
  for (const t of tagList) t.count = t.posts.length;
  tagList.sort((a, b) => (a.count !== b.count ? b.count - a.count : byCodeUnits(a.slug, b.slug)));
  ctx.tags = tagList;
  const site = { title: input.site.title, base_url: base };
  const tagViews = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.count }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p, ctx));

  const out = {};
  const write = (path, text) => { out[path] = text; };
  for (const p of pages) {
    const values = { site, tags: tagViews, recent, page: pageOf(p, ctx) };
    write(`${p.dir === '' ? '' : `${p.dir}/`}${p.slug}/index.html`, templates.render(p.layout, [values], 0));
  }
  const perPage = input.site.per_page;
  const total = Math.max(1, Math.ceil(posts.length / perPage));
  for (let n = 1; n <= total; n++) {
    const slice = posts.slice((n - 1) * perPage, n * perPage);
    const values = {
      site,
      tags: tagViews,
      recent,
      posts: slice.map((p) => cardOf(p, ctx)),
      pager: {
        number: n,
        total,
        url: n === 1 ? `${base}/` : `${base}/page/${n}/`,
        newer_url: n === 1 ? '' : n === 2 ? `${base}/` : `${base}/page/${n - 1}/`,
        older_url: n === total ? '' : `${base}/page/${n + 1}/`,
      },
    };
    const path = n === 1 ? 'index.html' : `page/${n}/index.html`;
    if (templates.compiled.has('index')) write(path, templates.render('index', [values], 0));
  }
  for (const t of tagList) {
    if (!templates.compiled.has('tag')) break;
    const values = {
      site,
      tags: tagViews,
      recent,
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.count, posts: t.posts.map((p) => cardOf(p, ctx)) },
    };
    write(`tags/${t.slug}/index.html`, templates.render('tag', [values], 0));
  }
  if (templates.compiled.has('tags')) {
    write('tags/index.html', templates.render('tags', [valuesOfTags(site, tagViews, recent)], 0));
  }
  for (const f of statics) {
    // Checked live: a static is shadowed by a built page, or by an earlier static at the same path.
    if (Object.hasOwn(out, f.path)) { ctx.reports.push(`shadowed ${f.path}: a built page has its path`); continue; }
    write(f.path, f.text);
  }
  const lines = [...ctx.reports].sort(byCodeUnits);
  const nPages = pages.reduce((n, p) => n + (p.isPost ? 0 : 1), 0);
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  write(REPORT_FILE, lines.map((l) => `${l}\n`).join(''));
  return out;
}

/** The values a tags index page sees. */
function valuesOfTags(site, tagViews, recent) {
  return { site, tags: tagViews, recent };
}

export default run;
