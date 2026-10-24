export function urlToChapter(url: string) {
  try {
    const fromQuery = new URL(url).searchParams.get('_chapter');
    if (fromQuery) return fromQuery;
  } catch {
    // not a valid absolute URL
  }

  const chapter = url.match(/[0-9]+\.[0-9]+(?:\.[0-9]+)?/)?.at(0);
  if (!chapter) throw `Could not determine chapter from url: ${url}`;
  return chapter;
}
