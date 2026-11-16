// fastmark — a fast, dependency-free Markdown to HTML renderer.
// Written from scratch for make.fun's "Make Markdown rendering faster" bounty.
// Output matches marked 18.1.3 with default options (GFM on, breaks off).

// ---------------------------------------------------------------- utilities

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

function isAsciiPunct(ch) {
  return ch !== undefined && ASCII_PUNCT.has(ch);
}

const PUNCT_RE = /[\p{P}\p{S}]/u;
const ZS_RE = /\p{Zs}/u;

function isPunctCh(ch) {
  if (ch === undefined) return false;
  if (ch.length === 1) {
    const c = ch.charCodeAt(0);
    if (c < 128) return ASCII_PUNCT.has(ch);
  }
  return PUNCT_RE.test(ch);
}

// CommonMark "Unicode whitespace": space, tab, LF, VT, FF, CR, and Zs chars.
// String boundaries (undefined) count as whitespace.
function isSpaceCh(ch) {
  if (ch === undefined) return true;
  const c = ch.codePointAt(0);
  if (c === 32 || (c >= 9 && c <= 13)) return true;
  if (c < 128) return false;
  return ZS_RE.test(ch);
}

// previous / next full code point (as a string) around an index
function prevCh(s, i) {
  if (i <= 0) return undefined;
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) return s.slice(i - 2, i);
  return s[i - 1];
}
function nextCh(s, i) {
  if (i >= s.length) return undefined;
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) return s.slice(i, i + 2);
  return s[i];
}

// ---------------------------------------------------------------- escaping

// Escape every HTML-special char unconditionally (code content, autolinks).
function escAll(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escChar(c) {
  switch (c) {
    case '&': return '&amp;';
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '"': return '&quot;';
    case "'": return '&#39;';
    default: return c;
  }
}

// If s[i] is '&' starting a character reference pattern, return
// { end, decoded } for numeric refs (decoded char) or { end, verbatim: true }
// for named patterns &[A-Za-z0-9]+; which pass through unchanged.
// Otherwise return null.
function matchEntityRef(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return null;
  if (s[j] === '#') {
    j++;
    let hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const start = j;
    if (hex) {
      while (j < n && j - start < 6 && isHexDigit(s[j])) j++;
    } else {
      while (j < n && j - start < 7 && s[j] >= '0' && s[j] <= '9') j++;
    }
    if (j === start || s[j] !== ';') return null;
    let v = parseInt(s.slice(start, j), hex ? 16 : 10);
    if (v === 0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) v = 0xfffd;
    return { end: j + 1, decoded: String.fromCodePoint(v) };
  }
  const start = j;
  while (j < n && isAlnum(s[j])) j++;
  if (j === start || s[j] !== ';') return null;
  return { end: j + 1, verbatim: true };
}

function isHexDigit(c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
function isAlnum(c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

// Escape a raw text run for HTML output: resolves backslash escapes of ASCII
// punctuation, decodes numeric character references, lets named reference
// patterns through verbatim, and escapes & < > " ' otherwise.
function escapeTextRun(raw) {
  const n = raw.length;
  let out = '';
  let start = 0;
  let i = 0;
  while (i < n) {
    const c = raw.charCodeAt(i);
    if (c === 92 && i + 1 < n && isAsciiPunct(raw[i + 1])) {
      out += raw.slice(start, i) + escChar(raw[i + 1]);
      i += 2; start = i;
    } else if (c === 38) {
      const m = matchEntityRef(raw, i);
      if (m) {
        out += raw.slice(start, i) + (m.verbatim ? raw.slice(i, m.end) : escChar(m.decoded));
        i = m.end; start = i;
      } else {
        out += raw.slice(start, i) + '&amp;';
        i += 1; start = i;
      }
    } else if (c === 60) { out += raw.slice(start, i) + '&lt;'; i++; start = i; }
    else if (c === 62) { out += raw.slice(start, i) + '&gt;'; i++; start = i; }
    else if (c === 34) { out += raw.slice(start, i) + '&quot;'; i++; start = i; }
    else if (c === 39) { out += raw.slice(start, i) + '&#39;'; i++; start = i; }
    else i++;
  }
  if (start === 0) return raw;
  return out + raw.slice(start);
}

// Plain-text form of a raw text run (for image alt text): backslash escapes
// resolved, numeric references decoded, named patterns kept verbatim.
function plainTextRun(raw) {
  const n = raw.length;
  let out = '';
  let start = 0;
  let i = 0;
  while (i < n) {
    const c = raw.charCodeAt(i);
    if (c === 92 && i + 1 < n && isAsciiPunct(raw[i + 1])) {
      out += raw.slice(start, i) + raw[i + 1];
      i += 2; start = i;
    } else if (c === 38) {
      const m = matchEntityRef(raw, i);
      if (m) {
        out += raw.slice(start, i) + (m.verbatim ? raw.slice(i, m.end) : m.decoded);
        i = m.end; start = i;
      } else i++;
    } else i++;
  }
  if (start === 0) return raw;
  return out + raw.slice(start);
}

// Escape an attribute value (href/title/alt): escapes & < > " ' but leaves
// existing character-reference patterns (&name;, &#123;, &#x1F;) untouched.
// No decoding and no backslash processing.
function escapeAttr(s) {
  const n = s.length;
  let out = '';
  let start = 0;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const m = matchEntityRef(s, i);
      if (m) { i = m.end; continue; } // keep verbatim: leave in the run
      out += s.slice(start, i) + '&amp;'; i++; start = i;
    } else if (c === 60) { out += s.slice(start, i) + '&lt;'; i++; start = i; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; i++; start = i; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; i++; start = i; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; i++; start = i; }
    else i++;
  }
  if (start === 0) return s;
  return out + s.slice(start);
}

function encodeHref(s) {
  try {
    return encodeURI(s).replace(/%25/g, '%');
  } catch {
    return s;
  }
}

// ------------------------------------------------------- link syntax pieces

function skipInlineWs(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  return i;
}

function isTitleStart(c) {
  return c === '"' || c === "'" || c === '(';
}

// Parse a link destination at s[i]. Returns { value, end, angle } or null.
function parseDestination(s, i) {
  const n = s.length;
  if (s[i] === '<') {
    let j = i + 1;
    let value = '';
    while (j < n) {
      const c = s[j];
      if (c === '\\' && isAsciiPunct(s[j + 1])) { value += s[j + 1]; j += 2; continue; }
      if (c === '>') return { value, end: j + 1, angle: true };
      if (c === '<' || c === '\n') return null;
      value += c; j++;
    }
    return null;
  }
  let j = i;
  let value = '';
  let depth = 0;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && isAsciiPunct(s[j + 1])) { value += s[j + 1]; j += 2; continue; }
    const code = s.charCodeAt(j);
    if (code <= 32) break;
    if (c === '(') { depth++; value += c; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; value += c; j++; continue;
    }
    value += c; j++;
  }
  if (depth !== 0) return null;
  return { value, end: j, angle: false };
}

// Parse a link title at s[i] (one of " ' (). Returns { value, end } or null.
function parseTitle(s, i) {
  const open = s[i];
  const close = open === '(' ? ')' : open;
  let j = i + 1;
  let value = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && isAsciiPunct(s[j + 1])) { value += s[j + 1]; j += 2; continue; }
    if (c === close) return { value, end: j + 1 };
    if (open === '(' && c === '(') return null;
    value += c; j++;
  }
  return null;
}

// Parse "( destination title? )" starting just after the '(' at s[i].
// Returns { href, title, end } or null.
function parseInlineLink(s, i) {
  let j = skipInlineWs(s, i);
  if (j >= s.length) return null;
  const dest = parseDestination(s, j);
  if (!dest) return null;
  j = dest.end;
  let title = null;
  const save = j;
  j = skipInlineWs(s, j);
  if (j > save && isTitleStart(s[j])) {
    const t = parseTitle(s, j);
    if (!t) return null;
    title = t.value;
    j = skipInlineWs(s, t.end);
  }
  if (s[j] === ')') return { href: dest.value, title, end: j + 1 };
  return null;
}

// Scan a [...] label starting at s[i] === '['. Link labels may not
// contain unescaped brackets. Returns { raw, end } or null.
function scanLinkLabel(s, i) {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && isAsciiPunct(s[j + 1])) { j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') {
      const raw = s.slice(i + 1, j);
      if (raw.length > 999) return null;
      return { raw, end: j + 1 };
    }
    j++;
  }
  return null;
}

const FOLD_MAP = { 'ß': 'ss', 'ς': 'σ', 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };
function normalizeLabel(raw) {
  let s = raw.replace(/[ \t\n]+/g, ' ');
  if (s.startsWith(' ')) s = s.slice(1);
  if (s.endsWith(' ')) s = s.slice(0, -1);
  return s.toLowerCase().replace(/[ßςﬀ-ﬆ]/g, (c) => FOLD_MAP[c] || c);
}

// Parse one link reference definition at text[pos].
// Returns { label, href, title, end } or null.
function parseLinkDef(text, pos) {
  const n = text.length;
  let i = pos;
  // up to 3 leading spaces
  let spaces = 0;
  while (i < n && text[i] === ' ' && spaces < 3) { i++; spaces++; }
  if (text[i] !== '[') return null;
  const lab = scanLinkLabel(text, i);
  if (!lab) return null;
  if (normalizeLabel(lab.raw) === '') return null;
  i = lab.end;
  if (text[i] !== ':') return null;
  i++;
  // optional whitespace, with at most one newline, before the destination
  while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
  if (text[i] === '\n') {
    i++;
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
  }
  const dest = parseDestination(text, i);
  if (!dest) return null;
  if (!dest.angle && dest.value === '') return null;
  i = dest.end;
  // optional title, separated by whitespace (possibly on the next line)
  let j = i;
  while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
  let tStart = j;
  if (text[j] === '\n') {
    tStart = j + 1;
    while (tStart < n && (text[tStart] === ' ' || text[tStart] === '\t')) tStart++;
  }
  if (tStart > i && isTitleStart(text[tStart])) {
    const t = parseTitle(text, tStart);
    if (t) {
      let k = t.end;
      while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
      if (k >= n) return { label: lab.raw, href: dest.value, title: t.value, end: k };
      if (text[k] === '\n') return { label: lab.raw, href: dest.value, title: t.value, end: k + 1 };
    }
    // the title did not pan out: fall back to a definition without one
  }
  // no title: the rest of the line must be blank
  let k = i;
  while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
  if (k >= n) return { label: lab.raw, href: dest.value, title: null, end: k };
  if (text[k] === '\n') return { label: lab.raw, href: dest.value, title: null, end: k + 1 };
  return null;
}

// Strip leading link reference definitions from a paragraph's text.
// Returns { remainder, defs }.
function stripDefs(text) {
  let pos = 0;
  const defs = [];
  for (;;) {
    const d = parseLinkDef(text, pos);
    if (!d) break;
    defs.push(d);
    pos = d.end;
  }
  return { remainder: text.slice(pos), defs };
}

// ------------------------------------------------------------ inline parser

// Parse an HTML tag starting at s[i] === '<'. Returns end index or -1.
function parseHtmlTag(s, i) {
  const n = s.length;
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= n || !/[A-Za-z]/.test(s[j])) return -1;
  j++;
  while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++;
  if (closing) {
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    return s[j] === '>' ? j + 1 : -1;
  }
  for (;;) {
    let ws = 0;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; ws++; }
    if (s[j] === '>') return j + 1;
    if (s[j] === '/' && s[j + 1] === '>') return j + 2;
    if (ws === 0) return -1;
    if (j >= n || !/[A-Za-z_:]/.test(s[j])) return -1;
    j++;
    while (j < n && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
    // optional = value
    let k = j;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (s[k] === '=') {
      k++;
      while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
      const q = s[k];
      if (q === '"' || q === "'") {
        const e = s.indexOf(q, k + 1);
        if (e === -1) return -1;
        j = e + 1;
      } else {
        let v = k;
        while (v < n && !' \t\n"\'=<>`'.includes(s[v])) v++;
        if (v === k) return -1;
        j = v;
      }
    }
  }
}

const SCHEME_AUTOLINK_RE = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/;
const EMAIL_AUTOLINK_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// Try to parse something starting with '<' at s[i]: comment, CDATA,
// processing instruction, declaration, autolink, or raw HTML tag.
// Returns { node, end } or null (the '<' is literal text).
function parseAngle(s, i) {
  const n = s.length;
  // comment (with the two abrupt empty-comment forms)
  if (s.startsWith('<!--', i)) {
    if (s[i + 4] === '>') return { node: { t: 'html', s: '<!-->' }, end: i + 5 };
    if (s[i + 4] === '-' && s[i + 5] === '>') return { node: { t: 'html', s: '<!--->' }, end: i + 6 };
    const e = s.indexOf('-->', i + 4);
    if (e !== -1) return { node: { t: 'html', s: s.slice(i, e + 3) }, end: e + 3 };
    return null;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const e = s.indexOf(']]>', i + 9);
    if (e !== -1) return { node: { t: 'html', s: s.slice(i, e + 3) }, end: e + 3 };
    return null;
  }
  if (s.startsWith('<?', i)) {
    const e = s.indexOf('?>', i + 2);
    if (e !== -1) return { node: { t: 'html', s: s.slice(i, e + 2) }, end: e + 2 };
    return null;
  }
  if (s[i + 1] === '!' && s[i + 2] >= 'A' && s[i + 2] <= 'Z') {
    const e = s.indexOf('>', i + 2);
    if (e !== -1) return { node: { t: 'html', s: s.slice(i, e + 1) }, end: e + 1 };
    return null;
  }
  // HTML tag
  const tagEnd = parseHtmlTag(s, i);
  if (tagEnd !== -1) return { node: { t: 'html', s: s.slice(i, tagEnd) }, end: tagEnd };
  // autolinks: candidate up to the next '>'
  const gt = s.indexOf('>', i + 1);
  if (gt !== -1 && gt - i <= 1100) {
    const cand = s.slice(i + 1, gt);
    if (!/[\s<]/.test(cand)) {
      const m = SCHEME_AUTOLINK_RE.exec(cand);
      if (m && m[0].length < cand.length) {
        return { node: { t: 'autolink', text: cand, href: cand }, end: gt + 1 };
      }
      if (EMAIL_AUTOLINK_RE.test(cand)) {
        return { node: { t: 'autolink', text: cand, href: 'mailto:' + cand }, end: gt + 1 };
      }
    }
  }
  return null;
}

// --- GFM extended autolinks ---

const URL_TRAILING_PUNCT = new Set(['?', '!', '.', ',', ':', '*', '_', '~', "'", '"']);

// If s ends with an entity-like tail (& + alphanumerics + ;), return the
// index of the '&'; otherwise -1.
function entityTailStart(s) {
  const n = s.length;
  if (n < 3 || s[n - 1] !== ';') return -1;
  let j = n - 2;
  let count = 0;
  while (j >= 0 && count < 32 && isAlnum(s[j])) { j--; count++; }
  if (j >= 0 && s[j] === '&' && count >= 1) return j;
  return -1;
}

// Trim a candidate extended-autolink string per GFM rules as marked
// implements them: an unmatched '(' (one whose paren group never closes)
// truncates the link; trailing punctuation, entity-like tails and stray
// closing parens are stripped. Paren groups close at the first ')'.
function trimAutolinkUrl(s) {
  // phase 1: truncate at an unmatched '('
  let i = 0;
  while (i < s.length) {
    if (s[i] === '(') {
      const close = s.indexOf(')', i + 1);
      if (close === -1) { s = s.slice(0, i); break; }
      i = close + 1;
    } else i++;
  }
  // phase 2: trailing strips
  for (;;) {
    if (s.length === 0) break;
    const last = s[s.length - 1];
    if (last === ')') {
      // stray if, scanning groups over s, the final ')' is outside a group
      let inGroup = false;
      for (let k = 0; k < s.length - 1; k++) {
        const c = s[k];
        if (c === '(' && !inGroup) inGroup = true;
        else if (c === ')' && inGroup) inGroup = false;
      }
      if (!inGroup) { s = s.slice(0, -1); continue; }
      break;
    }
    if (last === ';') {
      const amp = entityTailStart(s);
      if (amp >= 0) { s = s.slice(0, amp); continue; }
      s = s.slice(0, -1);
      continue;
    }
    if (URL_TRAILING_PUNCT.has(last)) { s = s.slice(0, -1); continue; }
    break;
  }
  return s;
}

const WS_RE = /\s/;

// Resolve backslash escapes of ASCII punctuation (no HTML escaping).
function unescapeBs(s) {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && isAsciiPunct(s[i + 1])) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

// Try a www. or http(s):// extended autolink at s[i].
// ctx: { textStart, nodes, brackets } for the www preceding-char rule.
function tryUrlAutolink(s, i, ctx) {
  const n = s.length;
  let kind = null;
  let prefixLen = 0;
  const c = s[i];
  if (c === 'w' && s.startsWith('www.', i)) {
    // preceding-character rule for www autolinks
    if (!wwwPrevOk(s, i, ctx)) return null;
    kind = 'www';
    prefixLen = 4;
  } else if (c === 'h' || c === 'H') {
    const head = s.slice(i, i + 8).toLowerCase();
    if (head.startsWith('http://')) { kind = 'url'; prefixLen = 7; }
    else if (head.startsWith('https://')) { kind = 'url'; prefixLen = 8; }
    else return null;
  } else {
    return null;
  }
  let j = i;
  while (j < n && s[j] !== '<' && !WS_RE.test(s[j])) j++;
  const cand = trimAutolinkUrl(s.slice(i, j));
  if (cand.length <= prefixLen) return null;
  const node = { t: 'autolink', text: cand, href: kind === 'www' ? 'http://' + cand : cand, ext: 1 };
  return { node, end: i + cand.length };
}

function wwwPrevOk(s, i, ctx) {
  if (i === 0) return true;
  if (s[i - 1] === '[' && ctx.openers && ctx.openers.has(i - 1)) {
    // right after a bracket opener: allowed only if a ']' appears later
    return s.indexOf(']', i) !== -1;
  }
  if (i > ctx.textStart) {
    const p = s[i - 1];
    if (isSpaceCh(p) || p === '(' || p === '*' || p === '_' || p === '~') return true;
    // an escaped character right before means a fresh chunk starts here
    if (isAsciiPunct(p)) {
      let bs = 0;
      let k = i - 2;
      while (k >= ctx.textStart && s[k] === '\\') { bs++; k--; }
      if (bs % 2 === 1) return true;
    }
    return false;
  }
  // start of a fresh text run: the previous node decides
  const prevNode = ctx.nodes[ctx.nodes.length - 1];
  if (prevNode && prevNode.t === 'text' && (prevNode.s === '[' || prevNode.s === '![')) {
    // after a bracket opener: allowed only if a ']' appears later
    return s.indexOf(']', i) !== -1;
  }
  if (prevNode && prevNode.t === 'text') {
    // a text node from a failed ']' — use the source character rule
    const p = s[i - 1];
    return isSpaceCh(p) || p === '(' || p === '*' || p === '_' || p === '~';
  }
  return true;
}

function isLocalChar(c) {
  return isAlnum(c) || c === '.' || c === '-' || c === '_' || c === '+';
}
function isDomainChar(c) {
  return isAlnum(c) || c === '.' || c === '-' || c === '_';
}
function isResourceChar(c) {
  return isAlnum(c) || c === '.' || c === '@';
}

function validEmailDomain(domain) {
  if (domain.length === 0) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (const lab of labels) if (lab.length === 0) return false;
  const lastLab = labels[labels.length - 1];
  return isAlnum(lastLab[lastLab.length - 1]);
}

// Try an email extended autolink: s[at] === '@', with the local part in the
// current text run [textStart, at). Returns { node, end, localStart } or null.
function tryEmailAutolink(s, at, textStart, delims) {
  let start = at;
  while (start > textStart && isLocalChar(s[start - 1])) start--;
  if (start === at) return null;
  // a backslash escape immediately before the local part consumes its
  // first character if that character is punctuation: the email can only
  // start after the escape
  if (start > textStart && s[start - 1] === '\\' && isAsciiPunct(s[start])) {
    let bs = 0;
    let k = start - 1;
    while (k >= textStart && s[k] === '\\') { bs++; k--; }
    if (bs % 2 === 1) {
      start++;
      if (start === at) return null;
    }
  }
  // optional mailto: / xmpp: prefix (lowercase, not preceded by alnum)
  let prefix = null;
  let linkStart = start;
  if (start - textStart >= 7 && s.slice(start - 7, start) === 'mailto:') {
    const before = start - 7;
    if (before === textStart || !isAlnum(s[before - 1])) { prefix = 'mailto:'; linkStart = before; }
  } else if (start - textStart >= 5 && s.slice(start - 5, start) === 'xmpp:') {
    const before = start - 5;
    if (before === textStart || !isAlnum(s[before - 1])) { prefix = 'xmpp:'; linkStart = before; }
  }
  // scan the domain
  let j = at + 1;
  while (j < s.length && isDomainChar(s[j])) j++;
  let dEnd = j;
  while (dEnd > at + 1 && s[dEnd - 1] === '.') dEnd--;
  // a trailing run of '_' may belong to a pending '_' delimiter (the
  // closing emphasis of an enclosing span) rather than to the domain
  if (delims && dEnd > at + 1 && s[dEnd - 1] === '_') {
    const pending = delims.some((d) => d.ch === '_' && d.canOpen && !d.dead && d.len > 0);
    if (pending) {
      while (dEnd > at + 1 && s[dEnd - 1] === '_') dEnd--;
      while (dEnd > at + 1 && s[dEnd - 1] === '.') dEnd--;
    }
  }
  const domain = s.slice(at + 1, dEnd);
  if (!validEmailDomain(domain)) return null;
  let end = dEnd;
  // xmpp: resource part — one '/' plus [A-Za-z0-9.@]+
  if (prefix === 'xmpp:' && s[end] === '/') {
    let k = end + 1;
    while (k < s.length && isResourceChar(s[k])) k++;
    if (k > end + 1) end = k;
  }
  const text = s.slice(linkStart, end);
  return {
    node: { t: 'autolink', text, href: prefix ? text : 'mailto:' + text, ext: 1 },
    end,
    localStart: linkStart,
    canAbsorb: !prefix && linkStart === start,
  };
}

// --- emphasis / strikethrough processing over the delimiter stack ---

function wrapNodes(nodes, openNode, closeNode, kind) {
  const a = nodes.indexOf(openNode);
  const b = nodes.indexOf(closeNode);
  const inner = nodes.splice(a + 1, b - a - 1);
  nodes.splice(a + 1, 0, { t: kind, kids: inner, ch: openNode.ch });
}

function removeNode(nodes, node) {
  const i = nodes.indexOf(node);
  if (i !== -1) nodes.splice(i, 1);
}

// Process delimiters with stack index >= bottom. Afterwards the delimiter
// stack is truncated to bottom entries.
// marked blocks an em (use-1) match when the content's tail — the
// text after the last nested em/strong/del wrapper, up to the closer —
// contains no whitespace.
function ruleSBlocked(nodes, opener, closer) {
  const a = nodes.indexOf(opener);
  const b = nodes.indexOf(closer);
  let wi = -1;
  for (let k = b - 1; k > a; k--) {
    const nd = nodes[k];
    if (nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') {
      wi = k;
      break;
    }
  }
  if (wi === -1) return false;
  const w = nodes[wi];
  // only a wrapper of the same delimiter family counts, and only a
  // strong wrapper or one facing a >= 2 opener
  if (w.ch !== closer.ch) return false;
  if (w.t !== 'strong' && opener.origLen < 2) return false;
  // the content right after the wrapper must start with a word
  // character (text glued to the wrapper, e.g. "**a**bc")
  const after = nodes[wi + 1];
  if (!after || after.t !== 'text' || !/^[\p{L}\p{N}]/u.test(after.s)) return false;
  // the character immediately before the wrapper must be whitespace
  const prev = nodes[wi - 1];
  if (!prev || prev.t !== 'text' || !/\s$/.test(prev.s)) return false;
  return true;
}

function processEmphasis(nodes, delims, bottom) {
  let ci = bottom;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (closer.dead || !closer.canClose || closer.len === 0) { ci++; continue; }
    // find nearest matching opener
    let opener = null;
    let oi = ci - 1;
    for (; oi >= bottom; oi--) {
      const o = delims[oi];
      if (o.dead || o.len === 0 || !o.canOpen || o.ch !== closer.ch) continue;
      if (o.ch === '~') {
        if (o.len === closer.len) { opener = o; break; }
        continue;
      }
      // marked: a delimiter that can also open cannot close a longer
      // opening run
      if (closer.canOpen && o.origLen > closer.origLen) continue;
      const odd = (o.canClose || closer.canOpen) &&
        ((o.origLen + closer.origLen) % 3 === 0) &&
        !((o.origLen % 3 === 0) && (closer.origLen % 3 === 0));
      if (odd) continue;
      // RULE S: an em match with a length-1 closer is blocked when a
      // nested wrapper sits directly (no whitespace) before the
      // closer and is itself preceded by whitespace in the content.
      // An opener blocked this way cannot form an em with a later
      // closer either (it may still form a strong).
      if (!(o.len >= 2 && closer.len >= 2)) {
        if (o.sBlocked) continue;
        if (closer.origLen === 1 && ruleSBlocked(nodes, o, closer)) {
          o.sBlocked = true;
          continue;
        }
      }
      opener = o; break;
    }
    if (!opener) { ci++; continue; }
    let use, kind;
    if (closer.ch === '~') { use = closer.len; kind = 'del'; }
    else if (opener.len >= 2 && closer.len >= 2) { use = 2; kind = 'strong'; }
    else { use = 1; kind = 'em'; }
    opener.len -= use;
    closer.len -= use;
    wrapNodes(nodes, opener, closer, kind);
    // a closer's leftover renders inside the wrapper when the
    // content's tail after the last nested construct has no space:
    // always when the tail runs into a leftover delimiter, and for
    // strong (use-2) matches also when it runs into a nested wrapper
    if (closer.len > 0) {
      const wi = nodes.indexOf(closer) - 1;
      const w = nodes[wi];
      if (w && (w.t === 'em' || w.t === 'strong' || w.t === 'del')) {
        let tail = '';
        let move = false;
        for (let k = w.kids.length - 1; k >= 0; k--) {
          const kid = w.kids[k];
          if (kid.t === 'text') {
            tail = kid.s + tail;
            if (/\s/.test(tail)) break;
          } else if (kid.t === 'delim') {
            move = true;
            break;
          } else if (kid.t === 'em' || kid.t === 'strong' || kid.t === 'del') {
            move = use === 2;
            break;
          } else break;
        }
        if (move && tail.length > 0 && !/\s/.test(tail) && /[\p{L}\p{N}]$/u.test(tail)) {
          w.kids.push({ t: 'text', s: closer.ch.repeat(closer.len) });
          closer.len = 0;
        }
      }
    }
    for (let k = oi + 1; k < ci; k++) delims[k].dead = true;
    if (opener.len === 0) { opener.dead = true; removeNode(nodes, opener); }
    if (closer.len === 0) { closer.dead = true; removeNode(nodes, closer); ci++; }
  }
  delims.length = bottom;
}

function flanking(ch, prev, next) {
  const lf = !isSpaceCh(next) && (!isPunctCh(next) || isSpaceCh(prev) || isPunctCh(prev));
  const rf = !isSpaceCh(prev) && (!isPunctCh(prev) || isSpaceCh(next) || isPunctCh(next));
  if (ch === '*') return { canOpen: lf, canClose: rf };
  return {
    canOpen: lf && (!rf || isPunctCh(prev)),
    canClose: rf && (!lf || isPunctCh(next)),
  };
}

// Handle a ']' at s[i]. Returns the new scan position.

// Where does the bracket opened just before `from` close, under
// marked's label matching? Backtick runs only shelter a ']' when the
// immediately following run has the same length (that pair is a code
// span); other runs are literal text for extent purposes.
function labelExtent(s, from) {
  const n = s.length;
  let depth = 0;
  let i = from;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let j = i + 1;
      while (j < n && s[j] === '`') j++;
      const len = j - i;
      // look ahead for the next run; a depth-0 ']' before it only
      // matters when the pair turns out unequal or missing
      let d = depth;
      let k = j;
      let nextLen = -1;
      let nextEnd = -1;
      let crossedClose = false;
      while (k < n) {
        const ck = s[k];
        if (ck === '\\') { k += 2; continue; }
        if (ck === '`') {
          let m = k + 1;
          while (m < n && s[m] === '`') m++;
          nextLen = m - k; nextEnd = m;
          break;
        }
        if (ck === '[') d++;
        else if (ck === ']') { if (d === 0) crossedClose = true; else d--; }
        k++;
      }
      if (nextLen === len) { i = nextEnd; continue; }
      if (nextLen !== -1 && !crossedClose) { i = nextEnd; continue; }
      i = j;
      continue;
    }
    if (c === '[') { depth++; i++; continue; }
    if (c === ']') { if (depth === 0) return i; depth--; i++; continue; }
    i++;
  }
  return -1;
}

function findCodeSpanClose(s, from, len) {
  let j = from;
  while (j < s.length) {
    if (s[j] === '`') {
      let m = 1;
      while (s[j + m] === '`') m++;
      if (m === len) return j;
      j += m;
    } else j++;
  }
  return -1;
}

// Find the end of the parenthesized group starting at s[from-1] === '(',
// honoring nesting, escapes and quoted strings; -1 if it never closes.
function scanParenEnd(s, from) {
  let depth = 1;
  let i = from;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < n && s[i] !== q && s[i] !== '\n') { if (s[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return -1;
}

function labelHasNestedBracket(s, from, to) {
  let i = from;
  while (i < to) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '[') return true;
    i++;
  }
  return false;
}

// marked's link matcher pairs up the backtick runs of a label; an
// odd leftover run poisons the fancy link forms — unless the leftover
// is a run of >= 2 backticks ending exactly at the label's end.
function labelCodePoison(s, from, to) {
  let count = 0;
  let lastLen = 0;
  let lastEnd = -1;
  let i = from;
  while (i < to) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let j = i + 1;
      while (j < to && s[j] === '`') j++;
      count++;
      lastLen = j - i;
      lastEnd = j;
      i = j;
      continue;
    }
    i++;
  }
  if (count % 2 === 0) return false;
  return !(lastLen >= 2 && lastEnd === to);
}

// Pre-pass over a paragraph's text deciding, for every bracket, whether
// it forms a link/image (and with what target), mirroring marked's
// label matcher: labels end where labelExtent says (not where a
// CommonMark code span would put the ']'), poisoned labels lose the
// fancy forms, and a formed link deactivates earlier link brackets.
// Also records "kill" ranges: labels of failed ](...) attempts whose
// emphasis delimiters marked leaves inert.
function resolveLinks(s, refs) {
  const formed = new Map();
  const kills = [];
  const interiors = [];
  const openers = new Set();
  const stack = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let m = 1;
      while (s[i + m] === '`') m++;
      const close = findCodeSpanClose(s, i + m, m);
      if (close === -1) { i += m; continue; }
      if (stack.length > 0) {
        const le = stack[stack.length - 1].labelEnd;
        if (le !== -1 && close + m > le) { i += m; continue; }
      }
      i = close + m;
      continue;
    }
    if (c === '<') {
      const r = parseAngle(s, i);
      if (r) { i = r.end; continue; }
      i++;
      continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      const cs = i + 2;
      stack.push({ start: i, contentStart: cs, isImage: true, active: true, labelEnd: labelExtent(s, cs) });
      openers.add(i + 1);
      interiors.push([cs, stack[stack.length - 1].labelEnd === -1 ? n : stack[stack.length - 1].labelEnd]);
      i += 2;
      continue;
    }
    if (c === '[') {
      const cs = i + 1;
      stack.push({ start: i, contentStart: cs, isImage: false, active: true, labelEnd: labelExtent(s, cs) });
      openers.add(i);
      interiors.push([cs, stack[stack.length - 1].labelEnd === -1 ? n : stack[stack.length - 1].labelEnd]);
      i += 1;
      continue;
    }
    if (c === ']' && stack.length > 0 && stack[stack.length - 1].labelEnd === i) {
      const op = stack.pop();
      let form = null;
      if (op.active) {
        const after = i + 1;
        const poison = labelCodePoison(s, op.contentStart, i);
        let href = null;
        let title = null;
        let end = -1;
        let triedLabel = false;
        if (!poison && s[after] === '(') {
          const r = parseInlineLink(s, after + 1);
          if (r) { href = r.href; title = r.title; end = r.end; }
        } else if (poison && s[after] === '[' && s[after + 1] === ']') {
          const key = normalizeLabel(s.slice(op.contentStart, i));
          const def = key !== '' ? refs.get(key) : undefined;
          if (def) { href = def.href; title = def.title; end = after + 2; }
        } else if (!poison && s[after] === '[') {
          const lab = scanLinkLabel(s, after);
          if (lab) {
            triedLabel = true;
            let key = normalizeLabel(lab.raw);
            if (key === '') key = normalizeLabel(s.slice(op.contentStart, i));
            const def = key !== '' ? refs.get(key) : undefined;
            if (def) { href = def.href; title = def.title; end = lab.end; }
          }
        }
        if (end === -1 && !triedLabel) {
          const key = normalizeLabel(s.slice(op.contentStart, i));
          const def = key !== '' ? refs.get(key) : undefined;
          if (def) { href = def.href; title = def.title; end = after; }
        }
        if (end !== -1) {
          form = { end, href, title, isImage: op.isImage, contentStart: op.contentStart, labelEnd: i };
        } else if (s[after] === '(' && scanParenEnd(s, after + 1) !== -1 &&
                   !labelHasNestedBracket(s, op.contentStart, i)) {
          kills.push([op.contentStart, i]);
        }
      }
      if (form) {
        formed.set(op.start + (op.isImage ? 1 : 0), form);
        if (!op.isImage) {
          for (const b of stack) if (!b.isImage) b.active = false;
        }
        i = form.end;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return { formed, kills, openers };
}

// Index of the next character at or after i that the inline scanner
// must stop for; everything before it is plain text.
function nextSpecial(text, i, n, autolinksOn) {
  let j = i;
  while (j < n) {
    const cc = text.charCodeAt(j);
    if (cc === 92 || cc === 96 || cc === 60 || cc === 91 || cc === 42 ||
        cc === 95 || cc === 126 || cc === 10 || cc === 33) break;
    if (autolinksOn) {
      if (cc === 64) break; // '@'
      if (cc === 119) { // 'w': only for www.
        if (text.charCodeAt(j + 1) === 119 && text.charCodeAt(j + 2) === 119 &&
            text.charCodeAt(j + 3) === 46) break;
      } else if (cc === 104 || cc === 72) { // 'h'/'H': only for http
        if ((text.charCodeAt(j + 1) | 32) === 116 &&
            (text.charCodeAt(j + 2) | 32) === 116 &&
            (text.charCodeAt(j + 3) | 32) === 112) break;
      }
    }
    j++;
  }
  return j;
}

const EMPTY_FORMED = new Map();
const EMPTY_SET = new Set();
function parseInlines(text, refs) {
  const nodes = [];
  const delims = [];
  const n = text.length;
  // link pre-pass: only needed when the text has a bracket at all
  let formed = EMPTY_FORMED, kills = null, openers = EMPTY_SET;
  if (text.includes('[')) {
    const r = resolveLinks(text, refs);
    formed = r.formed; kills = r.kills; openers = r.openers;
  }
  let killArr = null;
  if (kills && kills.length) {
    killArr = new Uint8Array(n);
    for (const [a, b] of kills) killArr.fill(1, a, b);
  }
  const inKillAt = (pos) => killArr !== null && killArr[pos] === 1;
  // marked masks CommonMark code spans over the raw paragraph text:
  // emphasis delimiters inside a masked region never form, even when
  // the span itself is interrupted by a link or other construct.
  let maskArr = null;
  if (text.includes('`') && (text.includes('*') || text.includes('_') || text.includes('~'))) {
    maskArr = new Uint8Array(n);
    let j = 0;
    while (j < n) {
      const cj = text[j];
      if (cj === '\\') { j += 2; continue; }
      if (cj === '`') {
        let m = 1;
        while (text[j + m] === '`') m++;
        const close = findCodeSpanClose(text, j + m, m);
        if (close === -1) { j += m; continue; }
        maskArr.fill(1, j, close + m);
        j = close + m;
        continue;
      }
      j++;
    }
  }
  const inMaskAt = (pos) => maskArr !== null && maskArr[pos] === 1;
  let i = 0;
  let textStart = 0;
  const flushText = (end) => {
    if (end > textStart) nodes.push({ t: 'text', s: text.slice(textStart, end) });
  };
  while (i < n) {
    const ni = nextSpecial(text, i, n, !LINK_STATE.inLink);
    if (ni > i) { i = ni; if (i >= n) break; }
    const c = text[i];
    if (c === '\\') {
      const d = text[i + 1];
      if (d === '\n') {
        flushText(i);
        nodes.push({ t: 'br' });
        i += 2;
        while (text[i] === ' ' || text[i] === '\t') i++;
        textStart = i;
      } else if (d !== undefined && isAsciiPunct(d)) {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (c === '`') {
      let m = 1;
      while (text[i + m] === '`') m++;
      const close = findCodeSpanClose(text, i + m, m);
      if (close === -1) { i += m; continue; }
      flushText(i);
      let content = text.slice(i + m, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      nodes.push({ t: 'code', s: content });
      i = close + m; textStart = i;
      continue;
    }
    if (c === '<') {
      const r = parseAngle(text, i);
      if (r) {
        flushText(i);
        nodes.push(r.node);
        if (r.node.t === 'html') {
          const raw = r.node.s;
          if (/^<a /i.test(raw)) LINK_STATE.inLink = true;
          else if (/^<\/a(?=[\s/>])/i.test(raw)) LINK_STATE.inLink = false;
        }
        i = r.end; textStart = i;
        continue;
      }
      i++; continue;
    }
    if (c === '!' && text[i + 1] === '[' && formed.has(i + 1)) {
      const f = formed.get(i + 1);
      flushText(i);
      const prevInLink = LINK_STATE.inLink;
      LINK_STATE.inLink = true;
      const inner = parseInlines(text.slice(f.contentStart, f.labelEnd), refs);
      LINK_STATE.inLink = prevInLink;
      nodes.push({ t: 'image', href: f.href, title: f.title, kids: inner });
      i = f.end; textStart = i;
      continue;
    }
    if (c === '[' && formed.has(i)) {
      const f = formed.get(i);
      flushText(i);
      const prevInLink = LINK_STATE.inLink;
      LINK_STATE.inLink = true;
      const inner = parseInlines(text.slice(f.contentStart, f.labelEnd), refs);
      LINK_STATE.inLink = prevInLink;
      const node = { t: 'link', href: f.href, title: f.title, kids: inner };
      nodes.push(node);
      i = f.end; textStart = i;
      continue;
    }
    if (c === '*' || c === '_') {
      let m = 1;
      while (text[i + m] === c) m++;
      if (inMaskAt(i)) { i += m; continue; }
      const prev = prevCh(text, i);
      const next = nextCh(text, i + m);
      const f = flanking(c, prev, next);
      if (!f.canOpen && !f.canClose) { i += m; continue; }
      flushText(i);
      const nd = { t: 'delim', ch: c, len: m, origLen: m, canOpen: f.canOpen, canClose: f.canClose, dead: inKillAt(i) };
      nodes.push(nd);
      delims.push(nd);
      i += m; textStart = i;
      continue;
    }
    if (c === '~') {
      let m = 1;
      while (text[i + m] === '~') m++;
      if (m <= 2 && inMaskAt(i)) { i += m; continue; }
      if (m <= 2) {
        const prev = prevCh(text, i);
        const next = nextCh(text, i + m);
        const canOpen = next !== undefined && !isSpaceCh(next);
        const canClose = prev !== undefined && !isSpaceCh(prev);
        if (!canOpen && !canClose) { i += m; continue; }
        flushText(i);
        const nd = {
          t: 'delim', ch: '~', len: m, origLen: m,
          canOpen, canClose,
          dead: inKillAt(i),
        };
        nodes.push(nd);
        delims.push(nd);
        i += m; textStart = i;
        continue;
      }
      i += m; continue;
    }
    if (c === '\n') {
      let sp = 0;
      let j = i - 1;
      while (j >= textStart && text[j] === ' ') { sp++; j--; }
      if (sp >= 2) {
        flushText(i - sp);
        nodes.push({ t: 'br' });
        i += 1;
        while (text[i] === ' ' || text[i] === '\t') i++;
        textStart = i;
        continue;
      }
      i++; continue;
    }
    if ((c === 'w' || c === 'h' || c === 'H') && !LINK_STATE.inLink) {
      const r = tryUrlAutolink(text, i, { textStart, nodes, openers });
      if (r) {
        flushText(i);
        nodes.push(r.node);
        i = r.end; textStart = i;
        continue;
      }
      i++; continue;
    }
    if (c === '@' && !LINK_STATE.inLink) {
      const r = tryEmailAutolink(text, i, textStart, delims);
      if (r) {
        flushText(r.localStart);
        // a '_' delimiter directly before the local part belongs to the
        // email if it never matches (decided after emphasis processing)
        if (r.canAbsorb && r.localStart === textStart) {
          const prev = nodes[nodes.length - 1];
          if (prev && prev.t === 'delim' && prev.ch === '_') r.node.absorbFrom = prev;
        }
        nodes.push(r.node);
        i = r.end; textStart = i;
        continue;
      }
      i++; continue;
    }
    i++;
  }
  flushText(n);
  processEmphasis(nodes, delims, 0);
  absorbUnderscores(nodes);
  return nodes;
}

// Merge a never-matched '_' delimiter into a following email autolink.
function absorbUnderscores(nodes) {
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.t === 'autolink' && nd.absorbFrom) {
      const prev = nodes[k - 1];
      if (prev === nd.absorbFrom && !prev.dead && prev.len === prev.origLen) {
        nd.text = '_'.repeat(prev.len) + nd.text;
        nd.href = 'mailto:' + nd.text;
        nodes.splice(k - 1, 1);
        k--;
      }
      delete nd.absorbFrom;
    }
    if (nd.kids) absorbUnderscores(nd.kids);
  }
}

// --- inline rendering ---

function altText(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': out += plainTextRun(nd.s); break;
      case 'code': out += nd.s; break;
      case 'html': out += nd.s; break;
      case 'br': break;
      case 'delim': out += nd.ch.repeat(nd.len); break;
      case 'autolink': out += nd.text; break;
      default:
        if (nd.kids) out += altText(nd.kids);
    }
  }
  return out;
}

function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': out += escapeTextRun(nd.s); break;
      case 'code': out += '<code>' + escAll(nd.s) + '</code>'; break;
      case 'html': out += nd.s; break;
      case 'br': out += '<br>'; break;
      case 'delim': out += nd.ch.repeat(nd.len); break;
      case 'em': out += '<em>' + renderNodes(nd.kids) + '</em>'; break;
      case 'strong': out += '<strong>' + renderNodes(nd.kids) + '</strong>'; break;
      case 'del': out += '<del>' + renderNodes(nd.kids) + '</del>'; break;
      case 'link':
        out += '<a href="' + escapeAttr(encodeHref(nd.href)) + '"' +
          (nd.title != null ? ' title="' + escapeAttr(nd.title) + '"' : '') +
          '>' + renderNodes(nd.kids) + '</a>';
        break;
      case 'image':
        out += '<img src="' + escapeAttr(encodeHref(nd.href)) + '" alt="' +
          escapeAttr(altText(nd.kids)) + '"' +
          (nd.title != null ? ' title="' + escapeAttr(nd.title) + '"' : '') + '>';
        break;
      case 'autolink':
        out += '<a href="' + escAll(encodeHref(nd.href)) + '">' + escAll(nd.text) + '</a>';
        break;
    }
  }
  return out;
}

function renderInline(text, refs) {
  return renderNodes(parseInlines(text, refs));
}

// ------------------------------------------------------------- block parser

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

// Document-level inline state: an `<a ` tag suppresses extended
// autolinks for the rest of the document (until `</a>`); link labels
// are lexed with the flag set and the previous value restored after.
// Reset at the start of every parse() call.
let LINK_STATE = { inLink: false };

export function parse(markdown) {
  LINK_STATE = { inLink: false };
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const refs = new Map();

  const doc = { t: 'doc', children: [], parent: null, open: true, lastLineBlank: false };
  const S = {
    line: '', offset: 0, column: 0,
    nextNonspace: 0, nextNonspaceColumn: 0, indent: 0, blank: true,
    tip: doc, doc, pendingHtml: null, containerTouched: false, frameBase: 0,
  };
  let lineIndex = 0;
  let totalLines = 0;
  const srcEndsWithNL = src.endsWith('\n');

  // ---------------------------------------------------------- state helpers

  function findNextNonspace() {
    const line = S.line;
    let i = S.offset;
    let col = S.column;
    while (i < line.length) {
      const c = line[i];
      if (c === ' ') col += 1;
      else if (c === '\t') col += 4 - (col % 4);
      else break;
      i++;
    }
    S.nextNonspace = i;
    S.nextNonspaceColumn = col;
    S.indent = col - S.column;
    S.blank = i >= line.length;
  }

  function advanceOffset(count, columnsOnly) {
    let line = S.line;
    while (count > 0 && S.offset < line.length) {
      const ch = line[S.offset];
      if (ch === '\t') {
        const tabWidth = 4 - (S.column % 4);
        if (columnsOnly && count < tabWidth) {
          // partially consume the tab: materialize the rest as spaces
          const rem = tabWidth - count;
          S.line = line = line.slice(0, S.offset) + ' '.repeat(rem) + line.slice(S.offset + 1);
          S.column += count;
          count = 0;
        } else {
          S.column += tabWidth;
          S.offset += 1;
          count -= columnsOnly ? tabWidth : 1;
        }
      } else {
        S.column += 1;
        S.offset += 1;
        count -= 1;
      }
    }
  }

  // advance over at most maxCols columns of leading whitespace
  function advanceIndentUpTo(maxCols) {
    while (maxCols > 0 && S.offset < S.line.length) {
      const c = S.line[S.offset];
      if (c === ' ') { advanceOffset(1, true); maxCols -= 1; }
      else if (c === '\t') {
        const w = 4 - (S.column % 4);
        if (w <= maxCols) { advanceOffset(1, false); maxCols -= w; }
        else { advanceOffset(maxCols, true); maxCols = 0; }
      } else break;
    }
  }

  function lastOpenChild(block) {
    const ch = block.children;
    if (!ch || ch.length === 0) return null;
    const last = ch[ch.length - 1];
    return last.open ? last : null;
  }

  function registerDefs(defs) {
    for (const d of defs) {
      const key = normalizeLabel(d.label);
      if (!refs.has(key)) refs.set(key, { href: d.href, title: d.title });
    }
  }

  function paraText(p) {
    if (!p.lines) return p.text;
    if (p._tcFor === p.lines && p._tcLen === p.lines.length) return p._tcText;
    const t = p.lines.join('\n');
    p._tcFor = p.lines; p._tcLen = p.lines.length; p._tcText = t;
    return t;
  }

  // stripDefs over the paragraph's current text, cached per text value
  function defsOf(p) {
    const t = paraText(p);
    if (p._dcText === t) return p._dcRes;
    const r = stripDefs(t);
    p._dcText = t; p._dcRes = r;
    return r;
  }
  function paraIsDefsOnly(p) {
    return defsOf(p).remainder === '';
  }

  function endsWithBlank(b) {
    if (b.lastLineBlank) return true;
    if ((b.t === 'list' || b.t === 'item') && b.children && b.children.length) {
      return endsWithBlank(b.children[b.children.length - 1]);
    }
    return false;
  }

  function computeTight(list) {
    let tight = true;
    const items = list.children;
    for (let ii = 0; ii < items.length && tight; ii++) {
      const item = items[ii];
      if (item.lastLineBlank && ii < items.length - 1) { tight = false; break; }
      const kids = item.children;
      for (let ki = 0; ki < kids.length; ki++) {
        if (endsWithBlank(kids[ki]) && (ii < items.length - 1 || ki < kids.length - 1)) {
          tight = false;
          break;
        }
      }
    }
    list.tight = tight;
  }

  function finalize(b) {
    if (b.t === 'para') {
      const r = stripDefs(b.lines.join('\n'));
      registerDefs(r.defs);
      b.text = r.remainder;
      b.lines = null;
    } else if (b.t === 'code' && !b.fenced) {
      const L = b.lines;
      while (L.length && /^[ \t]*$/.test(L[L.length - 1])) L.pop();
    } else if (b.t === 'code' && b.fenced) {
      if (b.lines.length && b.lines[b.lines.length - 1] === '') b.lines.pop();
    } else if (b.t === 'list') {
      computeTight(b);
    }
    b.open = false;
    S.tip = b.parent;
  }

  function addChild(type, parent) {
    while (S.tip !== parent) finalize(S.tip);
    const b = { t: type, children: [], parent, open: true, lastLineBlank: false };
    if (type === 'para') b.lines = [];
    if (type === 'code' || type === 'html') b.lines = [];
    parent.children.push(b);
    S.tip = b;
    return b;
  }

  function closeDownTo(block) {
    while (S.tip !== block) finalize(S.tip);
  }

  // ------------------------------------------------------- container match

  function matchQuotePrefix() {
    if (S.indent <= 3 && S.line[S.nextNonspace] === '>') {
      const frameStart = S.column;
      advanceOffset(S.nextNonspaceColumn - S.column, true);
      advanceOffset(1, false); // '>'
      const c = S.line[S.offset];
      if (c === ' ') advanceOffset(1, false);
      else if (c === '\t') {
        // the optional space after '>' consumes one column of the tab,
        // measured in the frame this quote's text lives in (the column
        // where this match began), not the raw line frame
        const fw = 4 - ((S.column - frameStart) % 4);
        S.line = S.line.slice(0, S.offset) + ' '.repeat(fw - 1) + S.line.slice(S.offset + 1);
        S.column += 1;
      }
      S.containerTouched = true;
      return true;
    }
    return false;
  }

  function matchItemPrefix(item) {
    if (S.blank) return true;
    if (S.nextNonspaceColumn - S.column >= item.indentReq) {
      advanceOffset(item.indentReq, true);
      S.containerTouched = true;
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ block starts
  // All matchers are pure: they read S.line from S.nextNonspace.

  function matchATX() {
    const line = S.line;
    let i = S.nextNonspace;
    let level = 0;
    while (line[i] === '#' && level <= 6) { i++; level++; }
    if (level === 0 || level > 6) return null;
    const c = line[i];
    if (c !== undefined && c !== ' ' && c !== '\t') return null;
    let content = line.slice(i).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    if (/^#+$/.test(content)) content = '';
    else content = content.replace(/[ \t]+#+$/, '').replace(/[ \t]+$/, '');
    return { level, content };
  }

  function matchFence() {
    const line = S.line;
    const ns = S.nextNonspace;
    const ch = line[ns];
    if (ch !== '`' && ch !== '~') return null;
    let len = 0;
    while (line[ns + len] === ch) len++;
    if (len < 3) return null;
    const rest = line.slice(ns + len);
    if (ch === '`' && rest.includes('`')) return null;
    const info = rest.replace(/^[ \t]+|[ \t]+$/g, '');
    return { ch, len, info, indent: S.indent };
  }

  function matchHR() {
    const line = S.line;
    let i = S.nextNonspace;
    let ch = null;
    let count = 0;
    while (i < line.length) {
      const c = line[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      if (ch === null) {
        if (c !== '-' && c !== '_' && c !== '*') return false;
        ch = c; count = 1;
      } else if (c === ch) count++;
      else return false;
      i++;
    }
    return count >= 3;
  }

  function isSetextShape(s) {
    return /^=+[ \t]*$/.test(s) || /^-+[ \t]*$/.test(s);
  }

  function matchSetext() {
    const rest = S.line.slice(S.nextNonspace).replace(/[ \t]+$/, '');
    if (/^=+$/.test(rest)) return 1;
    if (/^-+$/.test(rest)) return 2;
    return 0;
  }

  function matchListItem() {
    const line = S.line;
    const ns = S.nextNonspace;
    const nsCol = S.nextNonspaceColumn;
    const c = line[ns];
    let kind, marker, start = null, markerLen;
    if (c === '-' || c === '+' || c === '*') {
      kind = 'ul'; marker = c; markerLen = 1;
    } else if (c >= '0' && c <= '9') {
      let j = ns;
      let num = 0;
      let digits = 0;
      while (j < line.length && line[j] >= '0' && line[j] <= '9') {
        num = num * 10 + (line.charCodeAt(j) - 48);
        j++; digits++;
        if (digits > 9) return null;
      }
      const d = line[j];
      if (d !== '.' && d !== ')') return null;
      kind = 'ol'; marker = d; start = num; markerLen = digits + 1;
    } else return null;
    const afterMarker = ns + markerLen;
    const mc = line[afterMarker];
    if (mc !== undefined && mc !== ' ' && mc !== '\t') return null;
    let col = nsCol + markerLen;
    let j = afterMarker;
    let wsCols = 0;
    while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
      if (line[j] === ' ') { col += 1; wsCols += 1; }
      else { const w = 4 - (col % 4); col += w; wsCols += w; }
      j++;
    }
    const empty = j >= line.length;
    return { kind, marker, start, markerLen, wsCols, empty };
  }

  function listsMatch(list, li) {
    return list.kind === li.kind && list.marker === li.marker;
  }

  // HTML block start; maxType is 6 if a paragraph is open (type 7 may not
  // interrupt a paragraph), else 7. Returns { type, endTag } or null.
  function matchHTMLBlockStart(maxType) {
    const line = S.line;
    const ns = S.nextNonspace;
    if (line[ns] !== '<') return null;
    const rest = line.slice(ns);
    let m;
    if ((m = /^<(script|pre|style|textarea)(?=[ \t>]|$)/i.exec(rest))) {
      return { type: 1, endTag: m[1].toLowerCase() };
    }
    if (rest.startsWith('<!--')) return { type: 2 };
    if (rest.startsWith('<?')) return { type: 3 };
    if (/^<![A-Z]/.test(rest)) return { type: 4 };
    if (rest.startsWith('<![CDATA[')) return { type: 5 };
    if ((m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[ \t>]|\/>|$)/.exec(rest)) &&
        BLOCK_TAGS.has(m[1].toLowerCase())) {
      return { type: 6 };
    }
    if (maxType >= 7) {
      const end = parseHtmlTag(line, ns);
      if (end !== -1 && /^[ \t]*$/.test(line.slice(end))) return { type: 7 };
    }
    return null;
  }

  function htmlEndFound(b, lineText) {
    switch (b.htmlType) {
      case 1: return new RegExp('</' + b.endTag + '>', 'i').test(lineText);
      case 2: return lineText.includes('-->');
      case 3: return lineText.includes('?>');
      case 4: return lineText.includes('>');
      case 5: return lineText.includes(']]>');
      default: return false;
    }
  }

  // --------------------------------------------------------------- tables

  function trimCellWS(s) {
    let a = 0, b = s.length;
    while (a < b && (s[a] === ' ' || s[a] === '\t')) a++;
    while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
    return a === 0 && b === s.length ? s : s.slice(a, b);
  }

  function splitRow(s) {
    s = trimCellWS(s);
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) {
      // trailing pipe counts unless escaped by an odd number of backslashes
      let bs = 0;
      let k = s.length - 2;
      while (k >= 0 && s[k] === '\\') { bs++; k--; }
      if (bs % 2 === 0) s = s.slice(0, -1);
    }
    const cells = [];
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && s[i + 1] === '|') i++;
      else if (c === '|') { cells.push(s.slice(start, i)); start = i + 1; }
    }
    cells.push(s.slice(start));
    for (let i = 0; i < cells.length; i++) {
      let c = cells[i];
      if (c.includes('\\|')) c = c.replace(/\\\|/g, '|');
      cells[i] = trimCellWS(c);
    }
    return cells;
  }

  function parseDelimiterRow(str) {
    const cells = splitRow(str);
    const aligns = [];
    for (const c of cells) {
      if (!/^:?-+:?$/.test(c)) return null;
      const left = c.startsWith(':');
      const right = c.endsWith(':');
      aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
    }
    return aligns;
  }

  function tryTableConvert(aligns) {
    const p = S.tip;
    const text = paraText(p);
    const nl = text.lastIndexOf('\n');
    const headLine = nl === -1 ? text : text.slice(nl + 1);
    const headCells = splitRow(headLine);
    if (headCells.length !== aligns.length) return false;
    const before = nl === -1 ? '' : text.slice(0, nl);
    const parent = p.parent;
    const rem = stripDefs(before);
    registerDefs(rem.defs);
    if (rem.remainder === '') {
      const idx = parent.children.indexOf(p);
      if (idx !== -1) parent.children.splice(idx, 1);
      p.open = false;
    } else {
      p.lines = rem.remainder.split('\n');
      finalize(p);
    }
    const tb = {
      t: 'table', children: [], parent, open: true, lastLineBlank: false,
      aligns, head: headCells, rows: [],
    };
    parent.children.push(tb);
    S.tip = tb;
    return true;
  }

  function tableLineStartsBlock() {
    findNextNonspace();
    if (S.blank) return true;
    if (S.indent >= 4) return true;
    if (S.line[S.nextNonspace] === '>') return true;
    if (matchATX()) return true;
    if (matchFence()) return true;
    if (matchHTMLBlockStart(7)) return true;
    if (matchHR()) return true;
    const li = matchListItem();
    if (li && !li.empty && (li.kind === 'ul' || li.start === 1)) return true;
    return false;
  }

  function isClosingFence(b) {
    if (S.indent > 3) return false;
    const line = S.line;
    let i = S.nextNonspace;
    let len = 0;
    while (line[i] === b.fenceCh) { i++; len++; }
    if (len < b.fenceLen) return false;
    return /^[ \t]*$/.test(line.slice(i));
  }

  // Does lineStr continue the container stream of `upto` (a container
  // block)? Simulates phase-1 matching from the document down to upto.
  function lineContinuesStream(lineStr, upto) {
    const chain = [];
    for (let b = upto; b && b.t !== 'doc'; b = b.parent) chain.unshift(b);
    let i = 0;
    let col = 0;
    const nonspaceFrom = (j, c) => {
      while (j < lineStr.length) {
        const ch = lineStr[j];
        if (ch === ' ') { c++; j++; }
        else if (ch === '\t') { c += 4 - (c % 4); j++; }
        else break;
      }
      return { idx: j, col: c };
    };
    for (const c of chain) {
      if (c.t === 'list') continue;
      if (c.t === 'quote') {
        const ns = nonspaceFrom(i, col);
        if (ns.col - col > 3) return false;
        if (lineStr[ns.idx] !== '>') return false;
        i = ns.idx + 1;
        col = ns.col + 1;
        if (lineStr[i] === ' ') { i++; col++; }
        else if (lineStr[i] === '\t') { i++; col += 4 - (col % 4); }
        continue;
      }
      if (c.t === 'item') {
        const ns = nonspaceFrom(i, col);
        if (ns.idx >= lineStr.length) return true; // blank continues an item
        if (ns.col - col < c.indentReq) return false;
        let need = c.indentReq;
        while (need > 0 && i < lineStr.length) {
          const ch = lineStr[i];
          if (ch === ' ') { col++; i++; need--; }
          else if (ch === '\t') {
            const w = 4 - (col % 4);
            if (w <= need) { col += w; i++; need -= w; }
            else { col += need; need = 0; }
          } else break;
        }
        continue;
      }
      return false;
    }
    return true;
  }

  // Would this line start a block once a definitions-only paragraph is
  // out of the way? (Defs-only paragraphs do not block interruption.)
  function startsBlockAfterDefs() {
    findNextNonspace();
    if (S.indent >= 4) return true; // indented code
    const ch = S.line[S.nextNonspace];
    if (ch === '>') return true;
    if (matchATX()) return true;
    if (matchFence()) return true;
    if (matchHTMLBlockStart(7)) return true;
    if (matchHR()) return true;
    if (matchListItem()) return true;
    return false;
  }

  // ------------------------------------------------------------ line intake

  // Marked slices container content from the raw line in a way that
  // expands tabs in the leading whitespace run to spaces (tab stops
  // counted in the original line). Content at document level keeps its
  // tabs. S.containerTouched records whether a quote/item prefix was
  // consumed on the current line.
  function expandSlice(slice, col) {
    if (!slice.includes('\t')) return slice;
    let out = '';
    let i = 0;
    let c = col;
    while (i < slice.length) {
      const ch = slice[i];
      if (ch === ' ') { out += ' '; c++; i++; }
      else if (ch === '\t') { const w = 4 - (c % 4); out += ' '.repeat(w); c += w; i++; }
      else break;
    }
    return out + slice.slice(i);
  }

  function contentSlice() {
    const s = S.line.slice(S.offset);
    return S.containerTouched ? expandSlice(s, S.column - S.frameBase) : s;
  }

  // Expand the leading whitespace run of S.line (from S.offset) in place.
  function expandLeadingRunInPlace() {
    const line = S.line;
    if (!line.includes('\t')) return;
    let i = S.offset;
    let c = S.column - S.frameBase;
    let out = '';
    let sawTab = false;
    while (i < line.length) {
      const ch = line[i];
      if (ch === ' ') { out += ' '; c++; i++; }
      else if (ch === '\t') { const w = 4 - (c % 4); out += ' '.repeat(w); c += w; i++; sawTab = true; }
      else break;
    }
    if (sawTab) S.line = line.slice(0, S.offset) + out + line.slice(i);
  }

  function addLineToPara(p) {
    p.lines.push(contentSlice());
    p.lastLineBlank = false;
  }

  function incorporateLine(lineStr) {
    S.line = lineStr;
    S.offset = 0;
    S.column = 0;
    S.containerTouched = false;
    S.frameBase = 0;
    const oldtip = S.tip;

    // Phase 1: match open containers
    let container = doc;
    let lastMatched = doc;
    let firstUnmatched = null;
    findNextNonspace();
    for (;;) {
      const child = lastOpenChild(container);
      if (!child) break;
      if (child.t === 'quote') {
        const bc = S.column;
        if (matchQuotePrefix()) { S.frameBase = bc; container = child; lastMatched = child; findNextNonspace(); }
        else { firstUnmatched = child; break; }
      } else if (child.t === 'item') {
        if (matchItemPrefix(child)) { container = child; lastMatched = child; findNextNonspace(); }
        else { firstUnmatched = child; break; }
      } else if (child.t === 'list') {
        container = child; lastMatched = child;
      } else break;
    }
    const allMatched = firstUnmatched === null;
    const blank = S.blank;
    const tip = S.tip;

    // An HTML block that ended via its close tag keeps the newline after
    // its last line iff the next line continues the same container stream
    // and is not blank within it (marked's raw-text slicing behavior).
    if (S.pendingHtml) {
      const pb = S.pendingHtml;
      S.pendingHtml = null;
      // the newline survives iff the next line of the same container
      // stream has any content at all (a whitespace-only line keeps it;
      // a truly empty stream line or a stream change drops it)
      pb.trailingNL = lastMatched === pb.parent && S.line.slice(S.offset).length > 0;
    }

    // An open fence consumes every line until its closing fence, even a
    // line that does not match the surrounding containers (marked behavior):
    // strip as much of the container prefixes as the line offers.
    if (tip.t === 'code' && tip.fenced) {
      let feed = false;
      if (allMatched && !blank) {
        feed = true;
      } else if (allMatched && blank) {
        // a blank line feeds a fenced block at document level, or in
        // containers when the container stream continues afterwards
        if (tip.parent.t === 'doc') feed = true;
        else {
          for (let k = lineIndex + 1; k < totalLines; k++) {
            if (/^[ \t]*$/.test(lines[k])) continue;
            feed = /^[ \t]/.test(lines[k]) || lines[k].startsWith('>');
            break;
          }
        }
      } else if (!blank && tip.lines.length > 0) {
        // swallow an unmatched line only once the fence has content,
        // and only if the unmatched containers are all list items
        // (a blockquote still ends the fence, per CommonMark)
        feed = true;
        for (let b = tip.parent; b && b !== lastMatched; b = b.parent) {
          if (b.t === 'quote') { feed = false; break; }
        }
      }
      if (feed) {
        if (isClosingFence(tip)) finalize(tip);
        else {
          let content = contentSlice();
          // marked removes up to fenceIndent whitespace *characters*,
          // but only from backtick fences (tilde fences keep theirs)
          let k = 0;
          while (tip.fenceCh === '`' && k < tip.fenceIndent && k < content.length &&
                 (content[k] === ' ' || content[k] === '\t')) k++;
          if (k > 0) content = content.slice(k);
          tip.lines.push(content);
        }
        return;
      }
    }

    // Leaf continuations (only when every container matched)
    if (allMatched) {
      if (tip.t === 'code' && !tip.fenced) {
        if (blank) {
          if (S.containerTouched) expandLeadingRunInPlace();
          advanceOffset(4, true);
          tip.lines.push(S.line.slice(S.offset));
          return;
        }
        if (S.indent >= 4) {
          if (S.containerTouched) expandLeadingRunInPlace();
          advanceOffset(4, true);
          tip.lines.push(S.line.slice(S.offset));
          return;
        }
      }
      if (tip.t === 'html') {
        if (!(blank && tip.htmlType >= 6)) {
          const content = contentSlice();
          tip.lines.push(content);
          tip.lastLine = lineIndex;
          if (tip.htmlType <= 5 && htmlEndFound(tip, content)) {
            tip.endKind = 'close';
            S.pendingHtml = tip;
            finalize(tip);
          }
          return;
        }
      }
      if (tip.t === 'table') {
        if (!blank && !tableLineStartsBlock()) {
          tip.rows.push(splitRow(S.line.slice(S.offset)));
          return;
        }
        // a whitespace-only line ending in a single tab at column 4
        // is a table row in marked, not a blank line
        if (blank && /^ {0,3}\t$/.test(S.line.slice(S.offset))) {
          tip.rows.push(splitRow(S.line.slice(S.offset)));
          return;
        }
      }
    }

    // A whitespace-only line at the very end of a paragraph's container
    // stream joins the paragraph instead of separating it (doc streams
    // end with a newline iff the source does; container streams never do).
    if (blank && allMatched && S.tip.t === 'para' && S.line.slice(S.offset).length > 0 &&
        (S.tip.parent.t === 'quote' || S.tip.parent.t === 'doc')) {
      const parent = S.tip.parent;
      let atEnd;
      if (lineIndex === totalLines - 1) atEnd = parent.t === 'quote' || !srcEndsWithNL;
      else atEnd = parent.t === 'quote' && !lineContinuesStream(lines[lineIndex + 1], parent);
      if (atEnd) {
        addLineToPara(S.tip);
        return;
      }
    }

    // Blank line: close the paragraph (if any) and unmatched blocks.
    // For list looseness, the blank marks the last child of the deepest
    // matched container — but a blank inside a blockquote marks nothing.
    if (blank) {
      if (lastMatched.t !== 'quote' && lastMatched !== doc) {
        const kids = lastMatched.children;
        const target = kids && kids.length ? kids[kids.length - 1] : lastMatched;
        target.lastLineBlank = true;
      }
      if (S.tip.t === 'para') finalize(S.tip);
      closeDownTo(lastMatched);
      // an item that is still empty ends at a blank line
      if (S.tip.t === 'item' && S.tip.children.length === 0) finalize(S.tip);
      return;
    }

    // A lazy line over a definitions-only paragraph: the definitions
    // register and the paragraph vanishes. If the line starts a block it
    // is reprocessed outside the unmatched containers; otherwise it is
    // text for the paragraph's parent.
    let cont = lastMatched;
    if (!allMatched && S.tip.t === 'para' && paraIsDefsOnly(S.tip)) {
      if (startsBlockAfterDefs()) {
        closeDownTo(lastMatched);
      } else {
        cont = S.tip.parent;
        finalize(S.tip);
      }
    }

    // Phase 2: block starts
    let consumed = false;
    for (;;) {
      findNextNonspace();
      if (S.blank) { consumed = true; break; } // line held only markers
      const indented = S.indent >= 4;
      // blockquote
      if (!indented && S.line[S.nextNonspace] === '>') {
        S.frameBase = S.column;
        matchQuotePrefix();
        cont = addChild('quote', cont.t === 'list' ? cont.parent : cont);
        S.containerTouched = true;
        continue;
      }
      // ATX heading
      if (!indented) {
        const h = matchATX();
        if (h) {
          const hb = addChild('head', cont.t === 'list' ? cont.parent : cont);
          hb.level = h.level;
          hb.text = h.content;
          finalize(hb);
          consumed = true;
          break;
        }
      }
      // fenced code
      if (!indented) {
        const f = matchFence();
        if (f) {
          const cb = addChild('code', cont.t === 'list' ? cont.parent : cont);
          cb.fenced = true;
          cb.fenceCh = f.ch;
          cb.fenceLen = f.len;
          cb.fenceIndent = f.indent;
          cb.info = f.info;
          consumed = true;
          break;
        }
      }
      // HTML block
      if (!indented) {
        const tipPara = S.tip.t === 'para' ? S.tip : null;
        const maxType = tipPara && !paraIsDefsOnly(tipPara) ? 6 : 7;
        const hb = matchHTMLBlockStart(maxType);
        if (hb) {
          const b = addChild('html', cont.t === 'list' ? cont.parent : cont);
          b.htmlType = hb.type;
          b.endTag = hb.endTag;
          const content = contentSlice();
          b.lines.push(content);
          b.lastLine = lineIndex;
          if (hb.type <= 5 && htmlEndFound(b, content)) {
            b.endKind = 'close';
            S.pendingHtml = b;
            finalize(b);
          }
          consumed = true;
          break;
        }
      }
      // setext heading / table: need an open paragraph whose containers
      // all matched this line
      if (!indented && S.tip.t === 'para' && allMatched) {
        const lvl = matchSetext();
        if (lvl) {
          const p = S.tip;
          const rem = defsOf(p);
          registerDefs(rem.defs);
          if (rem.remainder === '') {
            // the paragraph was only definitions: it vanishes and this
            // line is reprocessed as fresh content
            const parent = p.parent;
            finalize(p);
            cont = parent;
            continue;
          }
          p.t = 'head';
          p.level = lvl;
          p.text = rem.remainder.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
          p.lines = null;
          finalize(p);
          consumed = true;
          break;
        }
        let aligns = null;
        { // fast reject: a delimiter row uses only | : - space tab
          const L = S.line;
          let ok = true, dash = false;
          for (let q = S.nextNonspace; q < L.length; q++) {
            const cq = L[q];
            if (cq === '-') dash = true;
            else if (cq !== '|' && cq !== ':' && cq !== ' ' && cq !== '\t') { ok = false; break; }
          }
          if (ok && dash) aligns = parseDelimiterRow(L.slice(S.nextNonspace));
        }
        if (aligns && tryTableConvert(aligns)) {
          consumed = true;
          break;
        }
      }
      // thematic break
      if (!indented && matchHR()) {
        const b = addChild('hr', cont.t === 'list' ? cont.parent : cont);
        finalize(b);
        consumed = true;
        break;
      }
      // list item
      const li = indented ? null : matchListItem();
      if (li) {
        const tipPara = S.tip.t === 'para' ? S.tip : null;
        const realPara = tipPara && !paraIsDefsOnly(tipPara);
        // an item line is blocked from interrupting only when the open
        // paragraph sits directly in the container that would hold the
        // new list (and that container is not itself a list item)
        const blocked = realPara && cont === tipPara.parent && cont.t !== 'item' &&
          (li.empty || (li.kind === 'ol' && li.start !== 1));
        if (!blocked) {
          if (cont.t === 'list' && !listsMatch(cont, li)) {
            cont = addChild('list', cont.parent);
          } else if (cont.t !== 'list') {
            cont = addChild('list', cont);
          }
          cont.kind = li.kind;
          cont.marker = li.marker;
          if (cont.kind === 'ol' && cont.start === undefined) cont.start = li.start;
          const item = addChild('item', cont);
          // position at the item's content start; the item's continuation
          // indent requirement is measured from this line's frame base
          const frameCol = S.column;
          advanceOffset(S.nextNonspaceColumn - S.column, true);
          const pad = li.empty || li.wsCols >= 5 ? 1 : li.wsCols;
          item.indentReq = S.column - frameCol + li.markerLen + pad;
          advanceOffset(li.markerLen, false);
          advanceOffset(pad, true);
          S.containerTouched = true;
          cont = item;
          continue;
        }
      }
      // indented code block
      if (indented && S.tip.t !== 'para') {
        if (S.containerTouched) expandLeadingRunInPlace();
        advanceOffset(4, true);
        const b = addChild('code', cont.t === 'list' ? cont.parent : cont);
        b.fenced = false;
        b.lines.push(S.line.slice(S.offset));
        consumed = true;
        break;
      }
      if (indented && S.tip.t === 'para' && paraIsDefsOnly(S.tip)) {
        // the line may still be a definition title continuation
        const ext = paraText(S.tip) + '\n' + S.line.slice(S.offset);
        if (stripDefs(ext).remainder === '') {
          addLineToPara(S.tip);
          consumed = true;
          break;
        }
        closeDownTo(cont);
        continue;
      }
      break;
    }
    if (consumed) return;

    // Phase 3: a plain text line
    if (S.tip.t === 'para') {
      const p = S.tip;
      if (!allMatched) {
        // lazy continuation: a line indented 4+ columns drops those 4
        // columns when it is the paragraph's first continuation line,
        // or when the paragraph sits in the list item this line failed
        // to match; later lines are verbatim, except that a
        // setext-shaped line in a blockquote paragraph is re-indented
        if (S.indent >= 4 && (p.lines.length === 1 ||
            (p.parent.t === 'item' && firstUnmatched === p.parent))) {
          advanceOffset(4, true);
          p.lines.push(contentSlice());
          p.lastLineBlank = false;
        } else if (p.lines.length === 1) {
          p.lines.push(contentSlice());
          p.lastLineBlank = false;
        } else if (p.parent.t === 'quote' && lastMatched !== p.parent && S.indent < 4 &&
                   isSetextShape(S.line.slice(S.nextNonspace))) {
          p.lines.push('    ' + S.line.slice(S.nextNonspace));
          p.lastLineBlank = false;
        } else {
          p.lines.push(contentSlice());
          p.lastLineBlank = false;
        }
      } else {
        // inside a list item, a matched continuation line indented 4+
        // columns past the item's content drops those 4 columns
        if (p.parent.t === 'item' && S.indent >= 4) advanceOffset(4, true);
        addLineToPara(p);
      }
    } else {
      const p = addChild('para', cont.t === 'list' ? cont.parent : cont);
      addLineToPara(p);
    }
  }

  // ---------------------------------------------------------------- render

  function renderPara(b, refs, overrideText, prefix) {
    const text = overrideText !== undefined ? overrideText : b.text;
    if (text === '' && prefix === undefined) return '';
    const parent = b.parent;
    const tight = parent && parent.t === 'item' && parent.parent && parent.parent.t === 'list' && parent.parent.tight;
    const inner = (prefix || '') + renderInline(text, refs);
    if (tight) return inner;
    return '<p>' + inner + '</p>\n';
  }

  function renderItem(b, refs) {
    let out = '<li>';
    const kids = b.children;
    // task list checkbox on the first paragraph
    let taskPara = null;
    let taskChecked = false;
    let taskText = null;
    const first = kids[0];
    if (first && first.t === 'para') {
      const t = first.text;
      if (t.startsWith('[ ] ') || t.startsWith('[x] ') || t.startsWith('[X] ')) {
        taskPara = first;
        taskChecked = t[1] !== ' ';
        taskText = t.slice(4);
      }
    }
    for (const kid of kids) {
      if (kid === taskPara) {
        const cb = taskChecked
          ? '<input checked="" disabled="" type="checkbox"> '
          : '<input disabled="" type="checkbox"> ';
        out += renderPara(kid, refs, taskText, cb);
      } else {
        out += renderBlock(kid, refs);
      }
    }
    return out + '</li>\n';
  }

  function renderBlock(b, refs) {
    switch (b.t) {
      case 'doc':
        return b.children.map((c) => renderBlock(c, refs)).join('');
      case 'quote':
        return '<blockquote>\n' + b.children.map((c) => renderBlock(c, refs)).join('') + '</blockquote>\n';
      case 'list': {
        let open;
        if (b.kind === 'ul') open = '<ul>\n';
        else if (b.start === 1 || b.start === undefined || b.start === null) open = '<ol>\n';
        else open = '<ol start="' + b.start + '">\n';
        const close = b.kind === 'ul' ? '</ul>\n' : '</ol>\n';
        return open + b.children.map((c) => renderBlock(c, refs)).join('') + close;
      }
      case 'item':
        return renderItem(b, refs);
      case 'para':
        return renderPara(b, refs);
      case 'head':
        return '<h' + b.level + '>' + renderInline(b.text, refs) + '</h' + b.level + '>\n';
      case 'hr':
        return '<hr>\n';
      case 'code': {
        const content = b.lines.length ? b.lines.join('\n') + '\n' : '';
        let lang = '';
        if (b.fenced && b.info) lang = unescapeBs(b.info.split(/[ \t]/)[0]);
        return '<pre><code' + (lang ? ' class="language-' + escapeAttr(lang) + '"' : '') + '>' +
          escAll(content) + '</code></pre>\n';
      }
      case 'html': {
        let out = b.lines.join('\n');
        const keepNL = b.endKind === 'close'
          ? !!b.trailingNL
          : b.parent === doc && b.lastLine === totalLines - 1 && srcEndsWithNL;
        if (keepNL) out += '\n';
        return out;
      }
      case 'table': {
        const alignAttr = (a) => (a ? ' align="' + a + '"' : '');
        let out = '<table>\n<thead>\n<tr>\n';
        b.head.forEach((cell, i) => {
          out += '<th' + alignAttr(b.aligns[i]) + '>' + renderInline(cell, refs) + '</th>\n';
        });
        out += '</tr>\n</thead>\n';
        if (b.rows.length) {
          out += '<tbody>';
          for (const row of b.rows) {
            out += '<tr>\n';
            for (let i = 0; i < b.aligns.length; i++) {
              out += '<td' + alignAttr(b.aligns[i]) + '>' + renderInline(row[i] ?? '', refs) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody></table>\n';
        } else {
          out += '</table>\n';
        }
        return out;
      }
      default:
        return '';
    }
  }

  // ------------------------------------------------------------------ main

  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  totalLines = lines.length;
  for (let li = 0; li < lines.length; li++) {
    lineIndex = li;
    incorporateLine(lines[li]);
  }
  if (S.pendingHtml) {
    S.pendingHtml.trailingNL = S.pendingHtml.parent === doc && srcEndsWithNL;
    S.pendingHtml = null;
  }
  closeDownTo(doc);
  return renderBlock(doc, refs);
}
