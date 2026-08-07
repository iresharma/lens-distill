/** Lightweight PCA → 2D for embedding scatter (display only). */

function meanColumns(matrix: number[][]): number[] {
  const n = matrix.length;
  const d = matrix[0]!.length;
  const mean = new Array(d).fill(0) as number[];
  for (const row of matrix) {
    for (let j = 0; j < d; j++) mean[j]! += row[j]!;
  }
  for (let j = 0; j < d; j++) mean[j]! /= n;
  return mean;
}

function center(matrix: number[][], mean: number[]): number[][] {
  return matrix.map((row) => row.map((v, j) => v - mean[j]!));
}

/** Power iteration for top eigenvector of A (symmetric d×d), A given as rows of centered data via X^T X. */
function topEigen(
  xtx: number[][],
  dim: number,
  iters = 40,
): { vec: number[]; value: number } {
  let v = new Array(dim).fill(0).map(() => Math.random() - 0.5) as number[];
  let norm = Math.hypot(...v) || 1;
  v = v.map((x) => x / norm);

  for (let t = 0; t < iters; t++) {
    const Av = new Array(dim).fill(0) as number[];
    for (let i = 0; i < dim; i++) {
      let s = 0;
      for (let j = 0; j < dim; j++) s += xtx[i]![j]! * v[j]!;
      Av[i] = s;
    }
    norm = Math.hypot(...Av) || 1;
    v = Av.map((x) => x / norm);
  }

  const Av = new Array(dim).fill(0) as number[];
  for (let i = 0; i < dim; i++) {
    let s = 0;
    for (let j = 0; j < dim; j++) s += xtx[i]![j]! * v[j]!;
    Av[i] = s;
  }
  let value = 0;
  for (let i = 0; i < dim; i++) value += v[i]! * Av[i]!;
  return { vec: v, value };
}

function deflate(xtx: number[][], vec: number[], value: number) {
  const d = vec.length;
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < d; j++) {
      xtx[i]![j]! -= value * vec[i]! * vec[j]!;
    }
  }
}

/**
 * Project rows (n × d) to 2D via top-2 PCA.
 * For d=1536 this builds X^T X which is expensive at full dim — we first
 * randomly project to 64 dims (Johnson–Lindenstrauss style) then PCA.
 */
export function projectTo2D(embeddings: number[][]): { x: number; y: number }[] {
  if (!embeddings.length) return [];
  if (embeddings.length === 1) return [{ x: 0, y: 0 }];

  const d = embeddings[0]!.length;
  const REDUCED = Math.min(64, d);
  // Fixed seeded random projection for stability across runs
  const proj = makeRandomProjection(d, REDUCED, 42);
  const reduced = embeddings.map((e) => applyProjection(e, proj));

  const mean = meanColumns(reduced);
  const X = center(reduced, mean);
  const n = X.length;
  const dim = REDUCED;

  // Covariance-ish: X^T X
  const xtx: number[][] = Array.from({ length: dim }, () =>
    new Array(dim).fill(0),
  );
  for (const row of X) {
    for (let i = 0; i < dim; i++) {
      for (let j = i; j < dim; j++) {
        const v = row[i]! * row[j]!;
        xtx[i]![j]! += v;
        if (i !== j) xtx[j]![i]! += v;
      }
    }
  }
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) xtx[i]![j]! /= Math.max(n - 1, 1);
  }

  const e1 = topEigen(xtx, dim);
  deflate(xtx, e1.vec, e1.value);
  const e2 = topEigen(xtx, dim);

  return X.map((row) => {
    let x = 0;
    let y = 0;
    for (let j = 0; j < dim; j++) {
      x += row[j]! * e1.vec[j]!;
      y += row[j]! * e2.vec[j]!;
    }
    return { x, y };
  });
}

function makeRandomProjection(
  from: number,
  to: number,
  seed: number,
): number[][] {
  let s = seed >>> 0;
  const rand = () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff * 2 - 1;
  };
  const scale = 1 / Math.sqrt(to);
  return Array.from({ length: to }, () =>
    Array.from({ length: from }, () => rand() * scale),
  );
}

function applyProjection(vec: number[], proj: number[][]): number[] {
  return proj.map((row) => {
    let s = 0;
    for (let i = 0; i < row.length; i++) s += row[i]! * vec[i]!;
    return s;
  });
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}
