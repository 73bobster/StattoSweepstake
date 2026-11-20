// Tiny Neon SQL-over-HTTP client (no dependencies). Used only by the server function for the shared
// cache/budget tables. Everything is cast to text in SQL and parsed here to avoid type surprises.
export function makeSql(databaseUrl) {
  const u = new URL(databaseUrl);
  const host = u.hostname;
  const endpoint = `https://${host}/sql`;
  return async function sql(query, params = []) {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': databaseUrl, 'Neon-Raw-Text-Output': 'true', 'Neon-Array-Mode': 'false' },
      body: JSON.stringify({ query, params }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || `Database error (${r.status})`);
    return j.rows || [];
  };
}
