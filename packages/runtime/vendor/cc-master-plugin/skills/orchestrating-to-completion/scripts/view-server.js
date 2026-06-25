#!/usr/bin/env node
// cc-master board view server —— dependency-free local webview for a board's task DAG.
//
// Red line 1 (ADR-006): node/JS only, no jq/python/tsx. Pure stdlib http/fs.
// Red line 5 (ship-anywhere): binds 127.0.0.1 only, serves locally vendored assets —
//   ZERO network access at runtime. Everything under ./vendor/ is self-contained.
//
// Usage:  CC_MASTER_BOARD=/abs/path/to/<ts>-<pid>.board.json node view-server.js
// Prints exactly one line:  cc-master board view: http://127.0.0.1:<port>
// so a launcher can scrape the URL. Bind port 0 => OS picks a free port.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const BOARD_PATH = process.env.CC_MASTER_BOARD;
if (!BOARD_PATH) {
  console.error('cc-master board view: ERROR — CC_MASTER_BOARD env (absolute board path) is required');
  process.exit(1);
}

// Resolve served files relative to THIS script, never cwd (the launcher may run from anywhere).
const SCRIPT_DIR = __dirname;
const VENDOR_DIR = path.join(SCRIPT_DIR, 'vendor');
const HTML_PATH = path.join(SCRIPT_DIR, 'view.html');
// The shared graph-analysis core lives under ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/ (the ONE
// source of truth that hooks + the board-graph CLI + this webview all reuse — DRY, design
// §5.2/§5.8). The viewer loads these as classic <script>s so its analyze() delegates to the
// same analyzeGraph() instead of carrying a divergent copy. Both files are plugin-internal
// (the plugin's hooks and skills trees both ship), resolved relative to THIS script — never cwd.
//   ${CLAUDE_PLUGIN_ROOT}/skills/orchestrating-to-completion/scripts/ → ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/
const CORE_DIR = path.resolve(SCRIPT_DIR, '..', '..', '..', 'hooks', 'scripts');
// Only these two core files are exposed (allow-list, not an open hooks/ mount).
const CORE_FILES = new Set(['board-graph-core.js', 'board-lint-core.js']);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function contentType(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function sendNotFound(res, body) {
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body !== undefined ? body : '{}');
}

// Board home = directory containing the board file. discuss sidecars live alongside it.
const BOARD_HOME = path.dirname(BOARD_PATH);
// Board stem = board filename minus trailing ".board.json" (best-effort), used as a
// fallback to extract node_id from sidecar filenames like
//   <board-stem>--<node-id>--<compact-stamp>.decision.md
const BOARD_STEM = path.basename(BOARD_PATH).replace(/\.board\.json$/i, '');

// Parse a minimal flat `key: value` YAML frontmatter block (the only shape discuss
// sidecars emit). Pure hand-rolled — red line 1 forbids jq/python. Returns {} on any
// shape we don't recognize. Tolerant of torn writes (no closing fence => parse what we got).
function parseFrontmatter(text) {
  const out = {};
  // Frontmatter is a leading `---` fenced block. Tolerate a UTF-8 BOM / leading blank lines.
  const m = text.replace(/^﻿/, '').match(/^[ \t]*\r?\n?---[ \t]*\r?\n([\s\S]*?)(?:\r?\n---[ \t]*(?:\r?\n|$)|$)/);
  if (!m) {
    // Also accept a `---` on the very first line with no preceding newline.
    const m2 = text.replace(/^﻿/, '').match(/^---[ \t]*\r?\n([\s\S]*?)(?:\r?\n---[ \t]*(?:\r?\n|$)|$)/);
    if (!m2) return out;
    return parseFlatYaml(m2[1]);
  }
  return parseFlatYaml(m[1]);
}

function parseFlatYaml(block) {
  const out = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    let val = line.slice(idx + 1).trim();
    // Strip a single layer of matching quotes.
    if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
        (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// Extract the first non-empty line under a `## TL;DR` heading (case-insensitive),
// truncated to a sane length. Returns '' if no TL;DR section / no content.
function extractTldr(text) {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^#{1,6}\s/.test(line)) {
      // A heading line. Enter the section iff it's a TL;DR heading; otherwise leaving it.
      inSection = /^#{1,6}\s*TL;?\s*DR\b/i.test(line);
      continue;
    }
    if (inSection && line) {
      return line.length > 200 ? line.slice(0, 200) : line;
    }
  }
  return '';
}

// Pull <node-id> out of a filename shaped `<board-stem>--<node-id>--<stamp>.decision.md`.
// Returns '' if the shape doesn't match.
function nodeIdFromFilename(file) {
  const base = file.replace(/\.decision\.md$/i, '');
  const parts = base.split('--');
  // Expected: [stem..., nodeId, stamp]. The stamp is the last segment; nodeId is second-to-last.
  if (parts.length >= 3) return parts[parts.length - 2];
  return '';
}

// Build the /decisions.json payload by scanning BOARD_HOME for *.decision.md sidecars.
// Read-only, single directory level (no recursion, no symlink following). Any individual
// file that fails to read/parse is skipped — never throws, never 500s.
function collectDecisions() {
  let entries;
  try {
    entries = fs.readdirSync(BOARD_HOME, { withFileTypes: true });
  } catch (_e) {
    return []; // home gone / unreadable => empty, graceful.
  }
  const rows = [];
  // Cross-board filter (this board only): sidecars are named
  //   <board-stem>--<node-id>--<stamp>.decision.md
  // so a sidecar belonging to THIS board must start with `${BOARD_STEM}--`. A shared
  // cc-master home can hold several boards; without this prefix gate, another board's
  // same-named node (e.g. both have `D1`) would bleed into this board's cards and skew
  // the "discussed N times" count / latest TL;DR. Other boards' sidecars are dropped.
  const STEM_PREFIX = BOARD_STEM + '--';
  for (const ent of entries) {
    // Only plain files named *.decision.md, this directory level only. Don't follow
    // symlinks out of the home (mirrors the /vendor/* containment discipline).
    if (!ent.isFile()) continue;
    const file = ent.name;
    if (!/\.decision\.md$/i.test(file)) continue;
    // Belongs to this board only (cross-board bleed guard).
    if (!file.startsWith(STEM_PREFIX)) continue;
    const full = path.join(BOARD_HOME, file);
    let text;
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile()) continue; // symlink/dir masquerading => skip.
      text = fs.readFileSync(full, 'utf8');
    } catch (_e) {
      continue; // torn write / vanished mid-scan / unreadable => skip this one.
    }
    let fm;
    try {
      fm = parseFrontmatter(text);
    } catch (_e) {
      continue;
    }
    const nodeId = (fm.node_id && String(fm.node_id).trim()) || nodeIdFromFilename(file);
    if (!nodeId) continue; // can't attribute it to a node => not useful, skip.
    rows.push({
      node_id: nodeId,
      file,
      resolved_at: (fm.resolved_at && String(fm.resolved_at)) || '',
      ask_type: (fm.ask_type && String(fm.ask_type)) || '',
      tldr: extractTldr(text),
      // _stamp is an internal sort key (filename stamp, falls back to resolved_at); dropped before output.
      _stamp: stampFromFilename(file) || (fm.resolved_at && String(fm.resolved_at)) || '',
    });
  }

  // round = 1-based index within a node_id group, ordered ascending by stamp/resolved_at.
  const byNode = new Map();
  for (const r of rows) {
    if (!byNode.has(r.node_id)) byNode.set(r.node_id, []);
    byNode.get(r.node_id).push(r);
  }
  for (const group of byNode.values()) {
    group.sort((a, b) => (a._stamp < b._stamp ? -1 : a._stamp > b._stamp ? 1 : (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)));
    group.forEach((r, i) => { r.round = i + 1; });
  }

  // Final order: by node_id, then by round.
  rows.sort((a, b) =>
    (a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : a.round - b.round));

  // Strip internal sort key and emit the pinned shape.
  return rows.map((r) => ({
    node_id: r.node_id,
    file: r.file,
    resolved_at: r.resolved_at,
    ask_type: r.ask_type,
    round: r.round,
    tldr: r.tldr,
  }));
}

// Last `--`-delimited segment (sans .decision.md) is the compact stamp; '' if absent.
// May carry a same-second collision-avoidance suffix (`<STAMP>-2`, `-3`, …) when two
// discusses on one node land in the same UTC second (discuss.md §5). The suffix sorts
// lexically AFTER the bare stamp (a prefix), and `-2` < `-3`, so the existing string
// sort still yields write order; the suffix is only a uniqueness tiebreak.
function stampFromFilename(file) {
  const base = file.replace(/\.decision\.md$/i, '');
  const parts = base.split('--');
  if (parts.length >= 3) return parts[parts.length - 1];
  return '';
}

const server = http.createServer((req, res) => {
  // Only GET is supported (read-only viewer).
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch (_e) {
    sendNotFound(res);
    return;
  }

  // GET / -> view.html
  if (urlPath === '/' || urlPath === '/index.html') {
    fs.readFile(HTML_PATH, (err, buf) => {
      if (err) {
        sendNotFound(res, 'view.html not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'], 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  // GET /favicon.ico -> 204 No Content. The viewer ships no icon; without this the
  // browser's automatic favicon request logs a lone 404 in the console. Silence it.
  if (urlPath === '/favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  // GET /board.json -> read the board fresh each request (no cache). Board may be
  // mid-write by the orchestrator; on any read/parse failure return 404 + {} so the
  // client just retries on its next poll (no crash, no stale cache).
  if (urlPath === '/board.json') {
    fs.readFile(BOARD_PATH, 'utf8', (err, txt) => {
      if (err) {
        sendNotFound(res);
        return;
      }
      try {
        JSON.parse(txt); // validate; if it's a torn write we 404 and let client retry
      } catch (_e) {
        sendNotFound(res);
        return;
      }
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES['.json'],
        'Cache-Control': 'no-store',
      });
      res.end(txt);
    });
    return;
  }

  // GET /decisions.json -> scan the board home for discuss sidecars (*.decision.md) and
  // return them as a pinned-shape JSON array. Read-only, single dir level, no symlink
  // follow-out (mirrors /vendor/* containment). Any unreadable/torn/unparseable file is
  // skipped; a missing home or zero sidecars yields [] (200) — graceful, never 500.
  if (urlPath === '/decisions.json') {
    let payload;
    try {
      payload = collectDecisions();
    } catch (_e) {
      payload = []; // defensive: any unexpected failure degrades to empty, not 500.
    }
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES['.json'],
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
    return;
  }

  // GET /core/<file>.js -> serve the shared graph-analysis core (board-graph-core.js /
  // board-lint-core.js) from ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/. Strict allow-list (CORE_FILES) — NOT an
  // open mount: only the two named files are reachable, no subpaths, no traversal. The
  // viewer loads these as classic <script>s so analyze() reuses the ONE analyzeGraph()
  // (DRY — no second copy of the graph algorithms in the browser). Read-only, no network.
  if (urlPath.startsWith('/core/')) {
    const name = urlPath.slice('/core/'.length);
    if (!CORE_FILES.has(name)) {
      sendNotFound(res);
      return;
    }
    const resolved = path.join(CORE_DIR, name);
    // Belt-and-suspenders: the resolved path must stay inside CORE_DIR (name has no
    // separators since it's an exact allow-list match, but verify regardless).
    if (resolved !== path.join(CORE_DIR, name) || path.dirname(resolved) !== CORE_DIR) {
      sendNotFound(res);
      return;
    }
    fs.readFile(resolved, (err, buf) => {
      if (err) {
        sendNotFound(res);
        return;
      }
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES['.js'],
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    });
    return;
  }

  // GET /vendor/* -> serve locally vendored assets, guarded against path traversal.
  if (urlPath.startsWith('/vendor/')) {
    const rel = urlPath.slice('/vendor/'.length);
    const resolved = path.resolve(VENDOR_DIR, rel);
    // Containment check: resolved must stay inside VENDOR_DIR.
    if (resolved !== VENDOR_DIR && !resolved.startsWith(VENDOR_DIR + path.sep)) {
      sendNotFound(res);
      return;
    }
    fs.readFile(resolved, (err, buf) => {
      if (err) {
        sendNotFound(res);
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentType(resolved),
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    });
    return;
  }

  sendNotFound(res);
});

// listen(0) => OS assigns a free port. Bind 127.0.0.1 only (no external exposure).
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  // Exactly one machine-scrapeable line.
  console.log('cc-master board view: http://127.0.0.1:' + port);
});

server.on('error', (err) => {
  console.error('cc-master board view: ERROR — ' + err.message);
  process.exit(1);
});
