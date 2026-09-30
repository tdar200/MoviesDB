// Fetch complete category membership before applying the TV's weighted rating.
import { rowSources, rowSourcesAtPage, dedupeItems, orderFeedItems } from './tv-rows.mjs';

// TMDB rejects page numbers above 500 even when total_pages reports more.
export const TMDB_MAX_PAGE = 500;
const PAGE_BATCH = 8;

export async function fetchCompleteTvRow(def, fetchJson, { isCurrent = () => true, onProgress = () => {}, pageBatch = PAGE_BATCH } = {}) {
  const batchSize = Math.max(1, Math.min(PAGE_BATCH, Number(pageBatch) || PAGE_BATCH));
  let loadedPages = 0;
  let totalPages = 0;
  let limited = false;
  let stopped = false;
  const checkCurrent = () => {
    if (stopped || !isCurrent()) {
      const error = new Error('Category loading cancelled');
      error.name = 'AbortError';
      throw error;
    }
  };
  const sources = rowSources(def);
  const sourceItems = await Promise.all(sources.map(async (src, index) => {
    const read = async page => {
      checkCurrent();
      const url = rowSourcesAtPage(def, page)[index].url;
      // The shared queue handles rate limiting. Retry a transient network error
      // once too, but never silently skip a failed page.
      let data;
      for (let attempt = 0; ; attempt++) {
        try { data = await fetchJson(url); break; }
        catch (error) { checkCurrent(); if (attempt >= 1) throw error; }
      }
      checkCurrent();
      const items = data && (src.list ? data.items : data.results);
      if (!Array.isArray(items)) throw new Error('Category response has no titles');
      loadedPages++;
      return { data, items: src.mediaType ? items.map(item => item && ({ ...item, media_type: item.media_type || src.mediaType })) : items };
    };
    const first = await read(1);
    const reportedPages = Math.max(1, Number(first.data.total_pages) || 1);
    // A short feed (Trending, Popular, New) reads only its first maxPages; every other
    // row reads its complete membership so the rating order is global.
    const lastPage = Math.min(TMDB_MAX_PAGE, reportedPages, Number(def.maxPages) > 0 ? Number(def.maxPages) : TMDB_MAX_PAGE);
    limited ||= reportedPages > TMDB_MAX_PAGE;
    totalPages += lastPage;
    onProgress({ loadedPages, totalPages });
    const pages = [first.items];
    for (let start = 2; start <= lastPage; start += batchSize) {
      checkCurrent();
      const batch = await Promise.all(Array.from({ length: Math.min(batchSize, lastPage - start + 1) }, (_, i) => read(start + i)));
      pages.push(...batch.map(page => page.items));
      onProgress({ loadedPages, totalPages });
    }
    return pages.flat();
  })).catch(error => {
    // Stop sibling feeds too; their late progress must not overwrite the error
    // state or keep scheduling pages after this category has failed.
    stopped = true;
    throw error;
  });
  checkCurrent();
  return { items: orderFeedItems(def, dedupeItems(sourceItems.flat().filter(item => item && (!item.media_type || item.media_type === 'movie' || item.media_type === 'tv')), new Set())), loadedPages, totalPages, limited };
}
