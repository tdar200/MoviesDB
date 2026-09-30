# Complete TV category loading

The TV previously loaded one to three initial pages and ranked only that partial pool. Later pages were appended in page order, so a stronger title fetched later could appear below weaker titles. Cross-row deduplication also removed valid members from later categories.

Categories now fetch every accessible page of each movie/show source before applying the existing weighted rating. Duplicates are removed within the category; overlap with other categories remains. Sources with fewer pages stop at their own total. Categories load in batches as the viewer moves down, with three category workers using the existing shared paced queue. Only 12 cards render initially; the complete sorted remainder renders as the viewer moves right. No horizontal scrolling fetches or reorders the category.

Failed pages receive one bounded network retry, then the category offers Retry category rather than showing partial results. Navigation cancels further scheduling. A failed mixed source stops its siblings too. Loading placeholders do not block fetching later categories, and a successful retry restores remote focus unless the viewer has moved elsewhere.

TMDB refuses pages above 500 per source, even if total_pages is larger. This external limit still applies to large feeds such as Popular and movie Top Rated. Those rows are sorted over all accessible titles, not over every title in TMDB. The row records this as data-row-limited. See [TMDB staff confirmation](https://www.themoviedb.org/talk/663c9dc9f56a7dbb62db705f?language=kk-KZ).

## Validation

- Full unit suite: 661 passed, 32 skipped, no failures. Final category/model/UI checks: 38 passed.
- Full TV browser suite: 24 passed, no failures. Additional retry regression verifies an unavailable middle page produces no partial cards and a retry returns the true ranking and focus.
- Live production catalogue check: 2,960 TMDB requests completed with no failed requests or page errors. All 12 initial categories were completely fetched within the API limit and their full weighted order was verified. Cold initial-batch completion took 86.9 seconds in headless desktop Chrome on this network. Rows finish independently during that time.
- Production Top Rated: 11,828 unique movie/show titles from 629 accessible pages, initially 12 rendered cards. Action & Adventure: 3,899 titles from 196 pages, initially 12 rendered cards. Complete measurements are in the adjacent production JSON report.
- After the owner requested reload, the actual LG Chrome 79 app was refreshed with cache bypass. The TV loaded bundle f4825c44ba and completed all 12 initial categories. Full weighted order, including held-back cards, was correct in every category. On-device Top Rated held 11,837 titles from 629 pages; Popular held 17,525 titles from 1,000 pages. Only 12 cards per row initially rendered. The detailed device result is in the adjacent tv.json report. The earlier app had only one to four pages per row.

The existing Movies production host was updated with a content-hashed ES2019 bundle. Reopening Movies loads the new version without reinstalling the webOS shell.
