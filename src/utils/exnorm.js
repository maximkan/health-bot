// Shared exercise-name normalizer — used by BOTH the catalog seed and the runtime resolver so their
// keys always match. Lowercase, strip punctuation, light/safe stemming (jumping→jump, running→run,
// swings→swing) and word-order independence. Safe stemming guards short stems ("swing" stays "swing").
function stemWord(w) {
  if (w.length > 4 && w.endsWith('ing')) { const s = w.slice(0, -3); if (s.length >= 3) return s.replace(/([a-z])\1$/, '$1'); }
  if (w.length > 4 && w.endsWith('ed'))  { const s = w.slice(0, -2); if (s.length >= 3) return s; }
  return w.replace(/s$/, '');
}
function normEx(s) {
  return String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).map(stemWord).sort().join(' ');
}
module.exports = { normEx, stemWord };
