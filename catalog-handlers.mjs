export function createYtsHandler(fetchYtsMovie) {
  return async function handleYts(res, url) {
  const imdb = url.searchParams.get('imdb');
  if (!imdb) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'missing imdb param' }));
  }
  try {
    const movie = await fetchYtsMovie(imdb);
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=3600',
    });
    res.end(
      JSON.stringify({
        title: movie?.title || null,
        year: movie?.year || null,
        torrents: movie?.torrents || [],
      })
    );
  } catch (err) {
    // Every YTS host was unreachable. Say so precisely: the helper is plainly
    // running (it is answering this request), so the app must not blame itself.
    console.error(`[yts] lookup failed for ${imdb}: ${(err.hostErrors || [String(err)]).join(' | ')}`);
    res.writeHead(502, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ error: 'yts_unreachable', detail: err.hostErrors || [String(err)] }));
  }
};
}
