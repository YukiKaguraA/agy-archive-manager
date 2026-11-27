import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

const { pending, words, mode, dbPath } = workerData;
const makeCandidates = () => new Map(pending.map(([id, terms]) => [id, new Set(terms)]));
let candidates = makeCandidates();
const snippets = new Map();
const candidateSql = 'conversation_id IN (SELECT value FROM json_each(?))';

function excerpt(text, word) {
  const index = text.toLowerCase().indexOf(word);
  if (index < 0) return '';
  const from = Math.max(0, index - 36);
  const to = Math.min(text.length, index + word.length + 72);
  return (from ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ').trim() + (to < text.length ? '…' : '');
}

function scanFields(db, columns) {
  // Node receives one matching candidate row at a time, regardless of the number of chunks.
  const rows = db.prepare('SELECT conversation_id, ' + columns.join(', ') +
    ' FROM conversations_fts WHERE ' + candidateSql).iterate(JSON.stringify([...candidates.keys()]));
  let remaining = candidates.size;
  for (const row of rows) {
    const id = row.conversation_id;
    const missing = candidates.get(id);
    if (!missing.size) continue;
    for (const col of columns) {
      const text = row[col];
      if (typeof text !== 'string' || !text) continue;
      const lower = text.toLowerCase();
      for (const term of missing) {
        if (lower.includes(term)) {
          missing.delete(term);
          if (!snippets.has(id)) snippets.set(id, excerpt(text, term));
        }
      }
    }
    if (!missing.size && --remaining === 0) break;
  }
}

function searchIndex(db, columns) {
  const sql = 'SELECT conversation_id, snippet(conversations_fts,-1,' +
    "'','','…',12) AS excerpt FROM conversations_fts WHERE conversations_fts MATCH ? AND " + candidateSql;
  const find = db.prepare(sql);
  for (const word of words) {
    const need = [...candidates].filter(([, missing]) => missing.has(word)).map(([id]) => id);
    if (!need.length) continue;
    // Only allow-listed content columns participate. Quotes force an FTS literal and bind parameters carry user input.
    const phrase = '{' + columns.join(' ') + '} : "' + word.replaceAll('"', '""') + '"';
    for (const row of find.iterate(phrase, JSON.stringify(need))) {
      candidates.get(row.conversation_id).delete(word);
      if (!snippets.has(row.conversation_id)) snippets.set(row.conversation_id, row.excerpt || '');
    }
    // An ID lacking this term cannot satisfy the remaining AND conditions, even across separate chunks.
    for (const id of need) if (candidates.get(id).has(word)) candidates.delete(id);
    if (!candidates.size) break;
  }
}

function run() {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'conversations_fts'").get();
    const names = new Set(db.prepare('PRAGMA table_info(conversations_fts)').all().map(col => col.name));
    const columns = ['user_body', 'agent_body', 'title'].filter(name => names.has(name));
    if (!names.has('conversation_id') || !columns.length) return { hits: [], warning: 'ftsUnreadable' };
    let indexed = mode === 'keywords' && /\bUSING\s+fts5\s*\(/i.test(schema?.sql || '');
    if (indexed) {
      try {
        searchIndex(db, columns);
      } catch {
        // Some FTS5 builds lack column queries or snippet support. Restart with the original candidates.
        indexed = false;
        candidates = makeCandidates();
        snippets.clear();
      }
    }
    if (!indexed) scanFields(db, columns);
    const hits = [...candidates].filter(([, missing]) => !missing.size).map(([id]) => [id, snippets.get(id) || '']);
    return { hits, warning: mode === 'keywords' && !indexed ? 'keywordFallback' : undefined };
  } catch {
    return { hits: [], warning: 'ftsUnreadable' };
  } finally {
    db?.close();
  }
}

parentPort.postMessage(run());
