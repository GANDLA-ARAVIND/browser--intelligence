/**
 * Cluster labelling by class-based TF-IDF (CLAUDE.md §5, §6).
 *
 * **No LLM, and that is a design decision rather than a limitation.** §5
 * originally specified LLM naming; §2.1 says no user data leaves the machine,
 * and the eight nearest-centroid titles of a cluster are the single most
 * identifying data the corpus holds — a real name, an employer shortlist, a
 * job-search timeline. Any cloud call would make the README's central claim
 * false, so the default path derives labels from the user's own titles and
 * sends nothing anywhere (DECISIONS.md).
 *
 * **c-TF-IDF is structurally immune to the generic-label failure**, which is
 * the specific thing §11's Phase 0 exit criterion warns about ("Technology" /
 * "Programming" / "Web Development"). A term scores highly for a cluster only
 * if it is frequent *inside* it and rare *across* the others, so a word common
 * corpus-wide cannot win anywhere — the arithmetic rules it out rather than a
 * blocklist doing so. That also means no stopword list is load-bearing here:
 * "the" loses because it is everywhere, not because it was banned.
 *
 * Everything here is browser-safe and language-agnostic. §14 requires any
 * string heuristic to be tested against Telugu, Chinese and Arabic before it
 * ships; see `scripts/validate.ts --labels` and the notes on CJK below.
 */

/**
 * Scripts that do not delimit words with spaces. A whole Chinese sentence
 * matches as ONE token — the mirror of the bug §14 records in the quality
 * scorer, where the same tokenizer inflated terminator density to 57 per 100
 * "words". A single 30-character token is useless as a label, so these runs
 * are emitted as character **bigrams** instead: language-agnostic, needs no
 * dictionary, and approximates segmentation well enough to *rank*.
 *
 * **Thai, Lao, Khmer and Myanmar are here, not just CJK.** §14 already notes
 * these four end sentences with a space; they do not separate *words* with one
 * either, and covering only CJK left a real Thai title as one 33-character
 * blob. Caught by the same test-against-other-scripts rule.
 *
 * Honest limitation: bigrams suit CJK, where one character is roughly one
 * morpheme, far better than Thai, where a syllable spans several characters
 * plus marks — Thai bigrams will cut mid-syllable. They still rank, and they
 * still beat emitting the whole sentence, but a Thai label will read worse
 * than a Chinese one. Proper segmentation needs a dictionary per language,
 * which §6 forbids shipping.
 */
const UNSPACED_SCRIPT =
  /[一-鿿㐀-䶿぀-ゟ゠-ヿ가-힯฀-๿຀-໿ក-៿က-႟]/u;

/** Terms this short carry nothing in any script once CJK is bigrammed. */
const MIN_TERM_LENGTH = 2;

export interface LabelOptions {
  /** Words in the finished label. §5 asks for 2–4. */
  maxTerms?: number;
  /** A term must appear in at least this many of a cluster's titles. */
  minTitleCount?: number;
  /**
   * Longest phrase considered. Unigrams alone lose word order — "sell · time ·
   * stock" carries the right information about "Best Time to Buy and Sell
   * Stock" and reads like a bag of words, because c-TF-IDF ranks terms
   * independently and cannot recover phrasing. Scoring n-grams as units lets
   * "buy and sell stock" and "data structures" win whole.
   */
  maxPhraseLength?: number;
}

export interface ClusterTitles {
  id: string;
  titles: string[];
}

export interface ClusterLabel {
  id: string;
  /** `null` when nothing survived — never an invented placeholder (§14). */
  label: string | null;
  /** The scored terms behind the label, strongest first. For inspection. */
  terms: Array<{ term: string; score: number }>;
}

/**
 * Letters, digits, **combining marks**, and the zero-width joiners.
 *
 * `\p{M}` is load-bearing and its absence was caught by §14's
 * test-against-Telugu-Chinese-Arabic rule before this shipped. Telugu, Hindi
 * and Thai write vowels as nonspacing marks, which are `\p{M}` and not
 * `\p{L}` — so `[\p{L}\p{N}]+` shattered every word at every vowel sign:
 * `डेटा संरचना` tokenized to `रचन`, `एल`, `दम`, and the Telugu half of a real
 * title produced **no terms at all**, meaning those clusters could only ever
 * be labelled by whatever Latin text happened to sit beside them.
 *
 * ZWNJ/ZWJ (U+200C/U+200D) are `\p{Cf}`, not marks, and Telugu and Devanagari
 * use them inside single words — `ప్లేస్‌మెంట్` contains one.
 */
const TERM_RUN = /[\p{L}\p{N}\p{M}‌‍']+/gu;

/**
 * Splits text into rankable terms without knowing its language.
 *
 * Latin, Telugu, Arabic and Devanagari delimit with spaces, so a run is a
 * word. CJK, Thai, Lao, Khmer and Myanmar do not, so those runs become
 * character bigrams.
 */
export function tokenizeForLabels(text: string): string[] {
  const runs = text.toLowerCase().match(TERM_RUN) ?? [];
  const terms: string[] = [];

  for (const run of runs) {
    if (!UNSPACED_SCRIPT.test(run)) {
      // At least one real letter: a bare "2026" or a stray mark is not a term.
      if (run.length >= MIN_TERM_LENGTH && /\p{L}/u.test(run)) terms.push(run);
      continue;
    }
    // An unspaced run: emit character bigrams, plus the run itself when it is
    // already short enough to be a word.
    if (run.length <= 3) {
      terms.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) terms.push(run.slice(i, i + 2));
  }

  return terms;
}

/**
 * Class-based TF-IDF over clusters.
 *
 * Each cluster is one "class"; its titles are concatenated into one document.
 * A term's weight is its normalized frequency inside the class, scaled by how
 * rare it is across classes:
 *
 *   score(t, c) = tf(t, c) × ln(1 + N / df(t))
 *
 * where `tf` is normalized by the class's total term count so a large cluster
 * does not outrank a small one on volume alone, `N` is the number of clusters
 * and `df(t)` how many contain `t`.
 *
 * Returns `label: null` for a cluster whose titles yield nothing rankable —
 * never a placeholder. §14: a cluster must not display a name it did not
 * derive, because an invented name is the §2 invented-metric problem in
 * another form.
 */
/**
 * Function words, used **only** to reject a phrase that starts or ends with
 * one — never to filter terms outright.
 *
 * c-TF-IDF needs no stopword list to beat "the": a word common corpus-wide
 * loses on IDF. N-grams reopen the problem from a different side, because a
 * *templated* phrase repeats verbatim across a cluster and earns real term
 * frequency — "at cognizant is just the beginning of your journey" outscored
 * every content phrase in that cluster. That is §14's repetition-sensitivity
 * rule arriving exactly where it warned it would: any frequency-based metric
 * meets templated text eventually.
 *
 * Boundary-only is the standard keyphrase rule and is the conservative form:
 * "buy and sell stock" keeps its interior `and`, while "time to buy and" and
 * "at cognizant is just" are rejected at the edges. On non-Latin text nothing
 * matches and no phrase is rejected — the same skip-rather-than-substitute
 * behaviour §14 requires of the quality scorer, so a Telugu cluster is never
 * silently stripped of its candidates.
 */
const BOUNDARY_STOPWORDS = new Set(
  'the be to of and a in that have it for not on with as you do at this but by from they we or an will my one all would there their what so up out if about who which go me when can no just him know into your some could them see than then now look only come its over also back after use how our first even new want because any these give most us is are was were been has had did'.split(
    ' '
  )
);

/**
 * Terms plus contiguous n-grams up to `maxPhraseLength`.
 *
 * N-grams are built inside a title only, never across the boundary between
 * two titles, so a phrase always reflects text that genuinely appeared next to
 * itself. They are **not** built across unspaced-script bigrams either: those
 * are already an approximation of segmentation, and chaining them would
 * compound the error rather than recover a phrase.
 */
function phrasesOf(title: string, maxPhraseLength: number): string[] {
  const words = tokenizeForLabels(title);
  if (maxPhraseLength <= 1) return words;

  const out = [...words];
  for (let n = 2; n <= maxPhraseLength; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const span = words.slice(i, i + n);
      if (BOUNDARY_STOPWORDS.has(span[0]!) || BOUNDARY_STOPWORDS.has(span[n - 1]!)) continue;
      out.push(span.join(' '));
    }
  }
  return out;
}

export function labelClusters(clusters: ClusterTitles[], options: LabelOptions = {}): ClusterLabel[] {
  // Two, not three. With unigrams a third term added information; with
  // n-grams the word-disjointness rule pushes the third pick far down the
  // ranking, so it is usually filler — "best time to buy · sell stock · based
  // key value store". A phrase already carries the word count §5 asked for.
  const maxTerms = options.maxTerms ?? 2;
  const minTitleCount = options.minTitleCount ?? 2;
  const maxPhraseLength = options.maxPhraseLength ?? 4;

  // Per cluster: term -> count, and term -> how many distinct titles held it.
  const termCounts: Array<Map<string, number>> = [];
  const titleCounts: Array<Map<string, number>> = [];
  const documentFrequency = new Map<string, number>();

  for (const cluster of clusters) {
    const counts = new Map<string, number>();
    const inTitles = new Map<string, number>();

    for (const title of cluster.titles) {
      const seenInThisTitle = new Set<string>();
      for (const term of phrasesOf(title, maxPhraseLength)) {
        counts.set(term, (counts.get(term) ?? 0) + 1);
        seenInThisTitle.add(term);
      }
      for (const term of seenInThisTitle) inTitles.set(term, (inTitles.get(term) ?? 0) + 1);
    }

    termCounts.push(counts);
    titleCounts.push(inTitles);
    for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }

  const N = clusters.length;

  return clusters.map((cluster, index) => {
    const counts = termCounts[index]!;
    const inTitles = titleCounts[index]!;
    const total = [...counts.values()].reduce((a, b) => a + b, 0);

    if (total === 0) return { id: cluster.id, label: null, terms: [] };

    const scored: Array<{ term: string; score: number }> = [];
    for (const [term, count] of counts) {
      // A term appearing in one title of forty is an accident of that title,
      // not a property of the cluster.
      if ((inTitles.get(term) ?? 0) < Math.min(minTitleCount, cluster.titles.length)) continue;
      const df = documentFrequency.get(term) ?? 1;

      // A phrase necessarily occurs no more often than its rarest word, so
      // without a length preference a unigram always outranks the phrase
      // containing it and the substring filter below then discards the phrase
      // — n-grams would be computed and never chosen. `sqrt(words)` is a
      // deliberate middle ground: a k-word phrase explains k times more of the
      // title but occurs fewer times, and a linear boost over-rewards long
      // accidental runs from templated titles.
      const words = term.split(' ').length;
      scored.push({ term, score: (count / total) * Math.log(1 + N / df) * Math.sqrt(words) });
    }

    scored.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));

    // Overlapping n-grams from one source phrase rank adjacently and say the
    // same thing three times — "best time to buy · buy and sell stock · time
    // to buy and". A substring test does not catch them, because neither
    // contains the other; they *overlap*. So a candidate is rejected when it
    // shares any word with something already chosen, which also subsumes the
    // old substring case ("leet" under "leetcode").
    const chosen: string[] = [];
    const claimedWords = new Set<string>();
    for (const { term } of scored) {
      if (chosen.length >= maxTerms) break;
      const words = term.split(' ');
      if (words.some((word) => claimedWords.has(word))) continue;
      if (chosen.some((kept) => kept.includes(term) || term.includes(kept))) continue;
      chosen.push(term);
      for (const word of words) claimedWords.add(word);
    }

    return {
      id: cluster.id,
      label: chosen.length > 0 ? chosen.join(' · ') : null,
      terms: scored.slice(0, 8),
    };
  });
}
