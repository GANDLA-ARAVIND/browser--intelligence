/**
 * Extraction quality, as distinct from extraction *method* (CLAUDE.md §8).
 *
 * The tier records which rung of the ladder handled a page. It says nothing
 * about whether the result is usable: Readability returns tier 2 for a GitHub
 * profile whose "article" is a navigation bar and twelve month names, and tier
 * 2 for a Medium essay. A coverage metric built on tier alone would report
 * 100% success on a corpus where a third of the text is worthless.
 *
 * These signals are structural. They catch text that is not prose. They cannot
 * catch text that is prose *about the wrong thing* — a YouTube description
 * instead of the transcript scores well and is still the wrong content. That
 * failure needs a site adapter, not a metric.
 */

/**
 * Common English function words. Prose runs 35–50% stopwords; navigation
 * chrome, tag lists and month names run near zero, because they are labels
 * rather than sentences.
 */
const STOPWORDS = new Set(
  ('the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us is are was were been has had said did'
    .split(' '))
);

export interface ExtractionQuality {
  chars: number;
  /** Extracted characters ÷ visible page text. Low means Readability found almost nothing. */
  coverage: number;
  /** Fraction of tokens that are stopwords. Null when the text is not mostly Latin script. */
  stopwordRatio: number | null;
  /**
   * Sentence terminators per 100 words. Prose runs 4–7; navigation chrome runs
   * near zero because labels are not sentences.
   *
   * Deliberately *not* "mean words per sentence": text with no terminators
   * collapses to a single enormous sentence, which makes chrome look like the
   * most well-formed prose in the corpus. Measured that inversion directly —
   * a GitHub nav bar scored a perfect 1.0 on it.
   */
  terminatorsPer100Words: number;
  /** Unique words ÷ total words. Repeated nav labels drive this down on long text. */
  typeTokenRatio: number;
  /** CJK characters plus non-CJK tokens — the script-neutral size measure. */
  units: number;
  /** 0–1. A blunt composite, useful for ranking and coverage stats. */
  score: number;
  verdict: 'good' | 'weak' | 'poor';
}

/**
 * Content is measured in **units**, not characters.
 *
 * A CJK character is roughly one morpheme — the informational weight of a
 * short English word — so character counts undercount Chinese and Japanese by
 * about 3×. Measured on translations of one paragraph: 123 chars in Chinese
 * and 144 in Japanese against 368 in English. A character-based floor rejects
 * genuine CJK prose as "too short".
 *
 * The word tokenizer has the mirror problem: `[\p{L}\p{N}]+` matches an entire
 * unspaced Chinese sentence as a single token, which inflated terminator
 * density to 57 per 100 "words" against 6.7 for the same English text.
 *
 * One unit = one CJK character, or one whitespace-delimited token elsewhere.
 */
const CJK = /[一-鿿㐀-䶿぀-ゟ゠-ヿ가-힯]/u;
const CJK_GLOBAL = new RegExp(CJK.source, 'gu');

/** Below this a page has effectively no extracted content. */
const MIN_USABLE_UNITS = 65;

/** Roughly the unit count of 1500 characters of English prose. */
const FULL_LENGTH_UNITS = 250;

/**
 * Sentence terminators, by script. A Latin-only class scores genuine Chinese,
 * Hindi and Urdu prose at zero density and rejects it as structureless.
 *
 *   Latin        . ! ?
 *   CJK          U+3002 U+FF01 U+FF1F
 *   Devanagari   U+0964 U+0965
 *   Arabic/Urdu  U+061F U+06D4
 *   Armenian     U+0589    Ethiopic U+1362    Tibetan U+0F0D
 */
const TERMINATORS = /[.!?。！？।॥؟۔։።།]/gu;

/**
 * Scripts that end sentences with a space rather than a mark: Thai, Lao,
 * Khmer, Myanmar. Terminator density is legitimately zero for these, so the
 * structural rule below must not apply to them.
 */
const NO_TERMINATOR_SCRIPTS = /[฀-๿຀-໿ក-៿က-႟]/u;

/**
 * Long text with no sentence terminator at all is not prose — a structural
 * fact about writing, not a tuned threshold. Concatenated UI labels
 * ("Prep for this interviewSoftware EngineerPrep for this interview") satisfy
 * every other signal and produce not one terminator in 700 characters — about
 * 115 units.
 */
const PROSE_REQUIRED_UNITS = 115;

function isMostlyLatin(text: string): boolean {
  const sample = text.slice(0, 2000);
  if (sample.length === 0) return false;
  const latin = sample.match(/[A-Za-z]/g)?.length ?? 0;
  return latin / sample.length > 0.3;
}

export function assessExtraction(text: string, pageTextLength: number): ExtractionQuality {
  const trimmed = text.trim();
  const words = trimmed.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  const terminators = trimmed.match(TERMINATORS)?.length ?? 0;

  const chars = trimmed.length;
  const coverage = pageTextLength > 0 ? Math.min(1, chars / pageTextLength) : 0;

  const cjkChars = trimmed.match(CJK_GLOBAL)?.length ?? 0;
  const nonCjkTokens = words.filter((word) => !CJK.test(word)).length;
  const units = cjkChars + nonCjkTokens;

  const terminatorsPer100Words = units > 0 ? (terminators / units) * 100 : 0;
  const typeTokenRatio = words.length > 0 ? new Set(words).size / words.length : 0;

  // Measured over the UNIQUE token set, not every occurrence.
  //
  // Over all tokens the metric answers "does this contain function words",
  // which repetition satisfies without being prose: a Naukri page repeating
  // "Prep for this interview" five times contributed `for` and `this` ten
  // times and scored 0.324 — inside prose range — for text that is a list of
  // UI labels. Per unique token, a repeated template contributes each function
  // word once.
  //
  // Still English-only, and still skipped rather than defaulted for non-Latin
  // text: substituting a neutral value would invent a measurement.
  const uniqueWords = new Set(words);
  const stopwordRatio = isMostlyLatin(trimmed)
    ? uniqueWords.size > 0
      ? [...uniqueWords].filter((word) => STOPWORDS.has(word)).length / uniqueWords.size
      : 0
    : null;

  const scriptUsesTerminators = !NO_TERMINATOR_SCRIPTS.test(trimmed);

  /**
   * A component that does not apply to the input is **dropped and its weight
   * redistributed**, never scored as zero.
   *
   * Scoring an inapplicable signal at zero is indistinguishable from measuring
   * it and finding nothing, which is how Thai prose — a script that ends
   * sentences with a space and has no terminator mark at all — scored 0.29 and
   * was rejected as structureless. The same mistake, made twice in one
   * function: the stopword component was already excluded for non-Latin text
   * while the terminator component was still being zeroed.
   */
  const components: Array<[weight: number, value: number]> = [[0.35, Math.min(1, units / FULL_LENGTH_UNITS)]];
  if (stopwordRatio !== null) components.push([0.4, Math.min(1, stopwordRatio / 0.3)]);
  if (scriptUsesTerminators) components.push([0.25, Math.min(1, terminatorsPer100Words / 4)]);

  const totalWeight = components.reduce((sum, [weight]) => sum + weight, 0);
  const score = Number(
    (components.reduce((sum, [weight, value]) => sum + weight * value, 0) / totalWeight).toFixed(3)
  );

  // Structural override. Only applied where the script actually uses
  // terminators — Thai, Lao, Khmer and Myanmar separate sentences with spaces,
  // so zero density there is normal prose, not a wall of labels.
  const structurelessProse = units >= PROSE_REQUIRED_UNITS && terminators === 0 && scriptUsesTerminators;

  const verdict: ExtractionQuality['verdict'] =
    structurelessProse || units < MIN_USABLE_UNITS || score < 0.35
      ? 'poor'
      : score < 0.6
        ? 'weak'
        : 'good';

  return {
    chars,
    coverage: Number(coverage.toFixed(3)),
    stopwordRatio: stopwordRatio === null ? null : Number(stopwordRatio.toFixed(3)),
    terminatorsPer100Words: Number(terminatorsPer100Words.toFixed(1)),
    typeTokenRatio: Number(typeTokenRatio.toFixed(3)),
    units,
    score,
    verdict,
  };
}
