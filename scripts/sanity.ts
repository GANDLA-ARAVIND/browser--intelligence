/**
 * Embedding pipeline sanity check.
 *
 * Runs before trusting anything validate.ts prints. Confirms the vectors have
 * the shape and scale they are assumed to have, and that known-similar,
 * known-related, and known-unrelated title pairs land where they should.
 *
 *   npm run sanity
 *
 * Exits non-zero on any failure, so it can gate a run on real data.
 */

import { readFile } from 'node:fs/promises';

// Must stay identical to validate.ts — checked mechanically in step 1.
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;
const PIPELINE_OPTIONS = { quantized: true } as const;
const EMBED_OPTIONS = { pooling: 'mean', normalize: true } as const;

let failures = 0;

function report(label: string, detail: string, ok: boolean): void {
  if (!ok) failures++;
  console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
}

// ---------------------------------------------------------------------------
// 1. Drift guard — prove validate.ts really does what this script tests
// ---------------------------------------------------------------------------

async function checkCallSiteMatches(): Promise<void> {
  console.log('\n[1] call-site drift guard');
  const source = await readFile(new URL('./validate.ts', import.meta.url), 'utf8');
  const lines = source.split('\n');

  const expectations: Array<{ label: string; needle: RegExp }> = [
    { label: `model is ${MODEL}`, needle: new RegExp(`['"]${MODEL.replace('/', '\\/')}['"]`) },
    { label: "pipeline passes { quantized: true }", needle: /pipeline\(\s*'feature-extraction',\s*MODEL,\s*\{\s*quantized:\s*true\s*\}/ },
    { label: "extractor passes pooling: 'mean'", needle: /extractor\([^)]*pooling:\s*'mean'/ },
    { label: 'extractor passes normalize: true', needle: /extractor\([^)]*normalize:\s*true/ },
    { label: `DIM is ${DIM}`, needle: new RegExp(`DIM\\s*=\\s*${DIM}\\b`) },
  ];

  for (const { label, needle } of expectations) {
    const index = lines.findIndex((line) => needle.test(line));
    report(label, index === -1 ? 'not found in validate.ts' : `validate.ts:${index + 1}`, index !== -1);
  }
}

// ---------------------------------------------------------------------------
// 2. Vector shape and scale
// ---------------------------------------------------------------------------

function l2(vec: Float32Array): number {
  let sum = 0;
  for (let d = 0; d < vec.length; d++) sum += vec[d]! * vec[d]!;
  return Math.sqrt(sum);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let d = 0; d < a.length; d++) dot += a[d]! * b[d]!;
  return dot / (l2(a) * l2(b) || 1);
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const ANCHOR = 'How to install Docker on Ubuntu';

/** Filler for the batch-consistency checks — deliberately spread across topics. */
const BATCH_CORPUS = [
  'Kubernetes Ingress explained', 'Bridge network driver configuration', 'Sourdough starter maintenance',
  'Fender Stratocaster pickup advice', 'Skilled Worker visa eligibility', 'Training finger strength hangboard',
  'Understanding ownership and borrowing', 'Self employment quarterly tax', 'Helm charts tutorial',
  'Why is my loaf so dense', 'Overdrive versus distortion pedal', 'Biometric residence permit',
  'Best beginner trad routes', 'Lifetimes in struct definitions', 'Home office deduction rules',
  'Multi stage builds smaller images', 'Debugging CrashLoopBackOff', 'Bulk fermentation timing',
  'Learning barre chords', 'Immigration health surcharge', 'Climbing shoes for bouldering',
  'Smart pointers Box Rc RefCell', 'Schedule C expense categories', 'Container healthchecks',
  'kubectl commands to know', 'Dutch oven versus baking stone', 'Acoustic guitar strings',
  'Spouse visa document list', 'Belay technique outdoors', 'Traits and generic parameters',
  'Filing a federal extension',
];

interface PairExpectation {
  label: string;
  other: string;
  min: number | null;
  max: number | null;
  rationale: string;
}

const PAIRS: PairExpectation[] = [
  {
    label: 'a) paraphrase',
    other: 'Installing Docker on Ubuntu',
    min: 0.85,
    max: null,
    rationale: 'same page, reworded',
  },
  {
    label: 'b) same topic, different subtopic',
    other: 'Docker networking explained',
    min: 0.4,
    max: 0.6,
    rationale: 'should cluster together, should not dedupe',
  },
  {
    label: 'c) unrelated',
    other: 'Best sourdough starter recipe',
    min: null,
    max: 0.15,
    rationale: 'must never share a cluster',
  },
];

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\nEmbedding pipeline sanity check');
  console.log('─'.repeat(74));

  await checkCallSiteMatches();

  const { pipeline, env } = await import('@xenova/transformers');
  env.cacheDir = './.models';

  console.log(`\n    loading ${MODEL}…`);
  const extractor = await pipeline('feature-extraction', MODEL, PIPELINE_OPTIONS);

  /** The exact call validate.ts makes, on an arbitrary batch. */
  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    const output = await extractor(texts, EMBED_OPTIONS);
    const data = output.data as Float32Array;
    return texts.map((_, i) => data.slice(i * DIM, (i + 1) * DIM));
  };

  // --- 2. shape and scale ---------------------------------------------------
  console.log('\n[2] vector shape and scale');
  const [anchor] = await embed([ANCHOR]);
  report('384 dimensions', `got ${anchor!.length}`, anchor!.length === DIM);

  const norm = l2(anchor!);
  report(
    'unit L2 norm (normalize: true took effect)',
    `‖v‖ = ${norm.toFixed(6)}`,
    Math.abs(norm - 1) < 1e-3
  );
  console.log(
    `          validate.ts treats a dot product as cosine (its dot() helper).\n` +
      `          That shortcut is only valid while ‖v‖ = 1.`
  );

  // --- 3. batch consistency -------------------------------------------------
  // validate.ts embeds in batches of 32 and then compares vectors that came out
  // of *different* batches. What it needs is therefore not solo/batch equality
  // but batch/batch equality: a title's vector must not depend on which batch it
  // landed in.
  //
  // It does depend on that, slightly. int8 kernels take a different accumulation
  // path per padded sequence width, and a batch's width is set by its longest
  // title. Measured: equal-width batches agree exactly, a short final batch
  // drifts to ~0.993, and padding that batch out with blank rows does not help
  // because row count is not the driver. fp32 shows no drift at all, which is
  // what rules out an attention-mask bug in mean pooling.
  //
  // So the invariant is asserted where validate.ts relies on it, the partial
  // final batch is reported rather than failed, and what actually matters —
  // neighbour rank, the only thing mutual-kNN reads — is asserted directly.
  console.log('\n[3] batch consistency');

  const partnersA = BATCH_CORPUS.slice(0, 31);
  const partnersB = BATCH_CORPUS.slice().reverse().slice(0, 31);

  const [inBatchA] = await embed([ANCHOR, ...partnersA]);
  const [inBatchAgain] = await embed([ANCHOR, ...partnersA]);
  const [inBatchB] = await embed([ANCHOR, ...partnersB]);
  const [inShortBatch] = await embed([ANCHOR, ...partnersA.slice(0, 15)]);

  report('identical call is deterministic', `cosine = ${cosine(inBatchA!, inBatchAgain!).toFixed(6)}`, cosine(inBatchA!, inBatchAgain!) > 0.99999);
  report(
    'same title, two different full batches',
    `cosine = ${cosine(inBatchA!, inBatchB!).toFixed(6)}`,
    cosine(inBatchA!, inBatchB!) > 0.9999
  );
  const partialDrift = cosine(inBatchA!, inShortBatch!);
  report(
    'short final batch within int8 tolerance',
    `cosine = ${partialDrift.toFixed(6)}  (expected ~0.993, int8 only)`,
    partialDrift > 0.99
  );

  // Rank stability: embed one corpus under two different batch groupings and
  // check the top-k neighbour lists are identical. Drift below this threshold
  // is invisible to the clustering.
  const corpus = [ANCHOR, ...BATCH_CORPUS];
  const grouping1 = await embed(corpus);
  const shuffled = corpus.map((text, index) => ({ text, index })).reverse();
  const shuffledVectors = await embed(shuffled.map((entry) => entry.text));
  const grouping2: Float32Array[] = [];
  shuffled.forEach((entry, position) => {
    grouping2[entry.index] = shuffledVectors[position]!;
  });

  const topK = (vectors: Float32Array[], target: number, k = 6): number[] =>
    vectors
      .map((vector, index) => ({ index, sim: cosine(vectors[target]!, vector) }))
      .filter((entry) => entry.index !== target)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, k)
      .map((entry) => entry.index);

  let identical = 0;
  for (let i = 0; i < corpus.length; i++) {
    if (topK(grouping1, i).join() === topK(grouping2, i).join()) identical++;
  }
  report(
    'top-6 neighbour rank survives regrouping',
    `${identical}/${corpus.length} identical`,
    identical === corpus.length
  );

  // --- 4. pair similarities -------------------------------------------------
  console.log('\n[4] pair similarities');
  console.log(`    anchor: "${ANCHOR}"\n`);

  const others = await embed(PAIRS.map((pair) => pair.other));
  for (const [index, pair] of PAIRS.entries()) {
    const score = cosine(anchor!, others[index]!);
    const expected =
      pair.min !== null && pair.max !== null
        ? `${pair.min}–${pair.max}`
        : pair.min !== null
          ? `> ${pair.min}`
          : `< ${pair.max}`;
    const ok = (pair.min === null || score >= pair.min) && (pair.max === null || score <= pair.max);

    if (!ok) failures++;
    console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${pair.label.padEnd(34)} ${score.toFixed(4)}   expect ${expected}`);
    console.log(`          "${pair.other}"`);
    console.log(`          ${pair.rationale}\n`);
  }

  // --- 5. what the wrong pooling would have given ---------------------------
  // Not a pass/fail — context for why { pooling: 'mean' } is not optional.
  console.log('[5] pooling comparison (informational)');
  const clsOutput = await extractor([ANCHOR, PAIRS[0]!.other, PAIRS[2]!.other], {
    pooling: 'cls',
    normalize: true,
  });
  const clsData = clsOutput.data as Float32Array;
  const cls = (i: number): Float32Array => clsData.slice(i * DIM, (i + 1) * DIM);
  const meanVectors = await embed([ANCHOR, PAIRS[0]!.other, PAIRS[2]!.other]);

  console.log(`    pooling            paraphrase    unrelated    separation`);
  const rows: Array<[string, Float32Array, Float32Array, Float32Array]> = [
    ['mean (in use)', meanVectors[0]!, meanVectors[1]!, meanVectors[2]!],
    ['cls', cls(0), cls(1), cls(2)],
  ];
  for (const [name, a, near, far] of rows) {
    const hit = cosine(a, near);
    const miss = cosine(a, far);
    console.log(
      `    ${name.padEnd(18)} ${hit.toFixed(4)}        ${miss.toFixed(4)}       ${(hit - miss).toFixed(4)}`
    );
  }
  console.log(
    `\n    all-MiniLM-L6-v2 was trained with mean pooling; cls is untrained here\n` +
      `    and its geometry is not the one the model learned.`
  );

  // --- verdict --------------------------------------------------------------
  console.log(`\n${'─'.repeat(74)}`);
  if (failures === 0) {
    console.log('ALL CHECKS PASSED — the embedding path is behaving as assumed.\n');
  } else {
    console.log(`${failures} CHECK(S) FAILED — do not trust validate.ts output until resolved.\n`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
