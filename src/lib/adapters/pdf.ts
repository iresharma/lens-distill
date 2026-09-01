import type { ParagraphUnit, ParseCalibration, ParseResult } from "./types";
import { otelLog } from "@/lib/otel/logger";

type TextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
};

type Line = {
  y: number;
  xStart: number;
  text: string;
  height: number;
  fontName: string;
  pageIndex: number; // 0-based pdf page
  pageHeight: number;
};

type ClassifiedLine = Line & {
  role: "chapterHeading" | "sectionHeading" | "body";
};

function mode(nums: number[], bucket = 0.5): number | null {
  if (!nums.length) return null;
  const counts = new Map<number, number>();
  for (const n of nums) {
    const k = Math.round(n / bucket) * bucket;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best: number | null = null;
  let bestC = 0;
  for (const [k, c] of counts) {
    if (c > bestC) {
      best = k;
      bestC = c;
    }
  }
  return best;
}

function buildLines(
  items: TextItem[],
  pageIndex: number,
  pageHeight: number,
): Line[] {
  const usable = items.filter((i) => i.str.trim().length > 0);
  usable.sort((a, b) => {
    const ay = a.transform[5] ?? 0;
    const by = b.transform[5] ?? 0;
    if (Math.abs(ay - by) > 2) return by - ay; // y desc
    return (a.transform[4] ?? 0) - (b.transform[4] ?? 0);
  });

  const lines: Line[] = [];
  let cur: TextItem[] = [];
  let curY = 0;

  const flush = () => {
    if (!cur.length) return;
    const widths = cur.map((i) => i.width / Math.max(i.str.length, 1));
    const meanChar = widths.reduce((a, b) => a + b, 0) / widths.length || 4;
    let text = cur[0]!.str;
    for (let i = 1; i < cur.length; i++) {
      const prev = cur[i - 1]!;
      const next = cur[i]!;
      const gap =
        (next.transform[4] ?? 0) - ((prev.transform[4] ?? 0) + prev.width);
      text += gap > 0.3 * meanChar ? " " + next.str : next.str;
    }
    text = text.replace(/\s+/g, " ").trim();
    if (!text) {
      cur = [];
      return;
    }
    const heights = cur.map((i) => i.height);
    const height = mode(heights, 0.25) ?? heights[0]!;
    lines.push({
      y: curY,
      xStart: cur[0]!.transform[4] ?? 0,
      text,
      height,
      fontName: cur[0]!.fontName || "",
      pageIndex,
      pageHeight,
    });
    cur = [];
  };

  for (const item of usable) {
    const y = item.transform[5] ?? 0;
    if (!cur.length) {
      cur = [item];
      curY = y;
      continue;
    }
    if (Math.abs(y - curY) <= 2.0) {
      cur.push(item);
    } else {
      flush();
      cur = [item];
      curY = y;
    }
  }
  flush();
  return lines;
}

function dehyphenate(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let t = lines[i]!;
    if (
      i + 1 < lines.length &&
      /[A-Za-z]-$/.test(t) &&
      !/--$/.test(t) &&
      /^[a-z]/.test(lines[i + 1]!)
    ) {
      t = t.slice(0, -1) + lines[i + 1];
      i++;
    }
    out.push(t);
  }
  return out;
}

/** Merge consecutive wrapped heading lines before classification. */
function mergeHeadingCandidates(
  pageLines: Line[],
  bodySize: number,
  lineSpacing: number,
): Line[] {
  const headingThreshold = 1.15 * bodySize;
  const chapterThreshold = 1.35 * bodySize;
  const out: Line[] = [];
  let i = 0;
  while (i < pageLines.length) {
    let cur = pageLines[i]!;
    let j = i + 1;
    while (j < pageLines.length) {
      const next = pageLines[j]!;
      const bothHeading =
        cur.height >= headingThreshold && next.height >= headingThreshold;
      const gap = cur.y - next.y;
      const sameFont = cur.fontName === next.fontName;
      // Chapter-sized wraps often switch embedded font subset names mid-title.
      const bothChapterSized =
        cur.height >= chapterThreshold && next.height >= chapterThreshold;
      const maxGap = bothChapterSized
        ? 2.5 * lineSpacing
        : 1.5 * lineSpacing;
      if (
        bothHeading &&
        gap <= maxGap &&
        (sameFont || bothChapterSized)
      ) {
        cur = {
          ...cur,
          text: `${cur.text} ${next.text}`.replace(/\s+/g, " ").trim(),
          height: Math.max(cur.height, next.height),
          y: cur.y,
        };
        j++;
      } else {
        break;
      }
    }
    out.push(cur);
    i = j;
  }
  return out;
}

function isLikelyHeaderFooter(line: Line): boolean {
  return (
    line.y > line.pageHeight * 0.92 || line.y < line.pageHeight * 0.08
  );
}

function classifyPageLines(
  pageLines: Line[],
  bodySize: number,
): ClassifiedLine[] {
  const merged = pageLines; // already merged by caller
  const out: ClassifiedLine[] = [];

  let firstContentIdx = -1;
  for (let i = 0; i < merged.length; i++) {
    if (!isLikelyHeaderFooter(merged[i]!)) {
      firstContentIdx = i;
      break;
    }
  }

  for (let i = 0; i < merged.length; i++) {
    const line = merged[i]!;
    const h = line.height;
    let role: ClassifiedLine["role"] = "body";

    if (h >= 1.35 * bodySize) {
      const isFirst = i === firstContentIdx;
      const followedByBody = merged
        .slice(i + 1, i + 4)
        .some((l) => l.height < 1.15 * bodySize);
      if (isFirst && followedByBody) {
        role = "chapterHeading";
      } else if (h >= 1.15 * bodySize) {
        role = "sectionHeading";
      }
    } else if (h >= 1.15 * bodySize && h < 1.35 * bodySize) {
      role = "sectionHeading";
    }

    out.push({ ...line, role });
  }
  return out;
}

function isStubParagraph(text: string): boolean {
  if (text.length >= 40) return false;
  const stripped = text.replace(/[\d\W_]+/g, " ");
  return !/[a-z]{3,}/i.test(stripped);
}

/**
 * Demote chapters with fewer than 15 paragraphs into sections of the previous
 * chapter. Repeat until stable.
 */
function demoteSmallChapters(paragraphs: ParagraphUnit[]): ParagraphUnit[] {
  const MIN_PARAS = 15;
  let changed = true;
  const current = paragraphs.map((p) => ({ ...p }));

  while (changed) {
    changed = false;
    const byChapter = new Map<number, ParagraphUnit[]>();
    for (const p of current) {
      if (p.chapterIndex == null) continue;
      const arr = byChapter.get(p.chapterIndex) || [];
      arr.push(p);
      byChapter.set(p.chapterIndex, arr);
    }

    const indices = [...byChapter.keys()].sort((a, b) => a - b);
    for (const idx of indices) {
      const paras = byChapter.get(idx)!;
      if (paras.length >= MIN_PARAS) continue;
      const prevIdx = indices.filter((i) => i < idx).pop();
      if (prevIdx == null) continue;

      const prevParas = byChapter.get(prevIdx)!;
      const demotedTitle = paras[0]?.chapterTitle ?? null;
      changed = true;

      for (const p of paras) {
        p.chapterIndex = prevIdx;
        p.chapterTitle = prevParas[0]?.chapterTitle ?? p.chapterTitle;
        if (demotedTitle && !p.sectionTitle) {
          p.sectionTitle = demotedTitle;
        }
      }
      break; // restart after one demotion
    }

    if (changed) {
      // Capture title per old chapter index, then renumber contiguously
      const titleByOld = new Map<number, string | null>();
      for (const p of current) {
        if (p.chapterIndex == null) continue;
        if (!titleByOld.has(p.chapterIndex)) {
          titleByOld.set(p.chapterIndex, p.chapterTitle);
        }
      }
      const oldToNew = new Map<number, number>();
      let n = 1;
      for (const old of [...titleByOld.keys()].sort((a, b) => a - b)) {
        oldToNew.set(old, n++);
      }
      for (const p of current) {
        if (p.chapterIndex == null) continue;
        const next = oldToNew.get(p.chapterIndex);
        if (next == null) continue;
        p.chapterTitle = titleByOld.get(p.chapterIndex) ?? p.chapterTitle;
        p.chapterIndex = next;
      }
    }
  }

  // Reassign paraIndex sequentially
  return current.map((p, i) => ({ ...p, paraIndex: i }));
}

function calibratePageOffset(
  pageNumSamples: { pdfPage: number; printed: number }[],
  numPages: number,
): {
  pageOffset: number | null;
  agreement: number | null;
  samples: ParseCalibration["pageOffsetSamples"];
} {
  // Exclude front matter: start at first page whose extracted integer is ≥ 1
  // and increases monotonically over 3 consecutive samples.
  const sorted = [...pageNumSamples].sort((a, b) => a.pdfPage - b.pdfPage);
  let startAt = 0;
  for (let i = 0; i + 2 < sorted.length; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    const c = sorted[i + 2]!;
    if (
      a.printed >= 1 &&
      b.printed > a.printed &&
      c.printed > b.printed
    ) {
      startAt = i;
      break;
    }
  }
  const usable = sorted.slice(startAt);
  const samples = usable.slice(0, 20).map((s) => ({
    pdfPageIndex: s.pdfPage,
    extractedInteger: s.printed,
    offset: s.printed - s.pdfPage,
  }));

  if (usable.length < 5) {
    otelLog.info(
      "page-offset: fewer than 5 usable samples after front-matter skip",
      {
        scope: "pdf",
        numPages,
        rawSamples: pageNumSamples.length,
        usable: usable.length,
      },
    );
    return { pageOffset: null, agreement: null, samples };
  }

  const offsets = usable.map((s) => s.printed - s.pdfPage);
  const offsetCounts = new Map<number, number>();
  for (const o of offsets) {
    offsetCounts.set(o, (offsetCounts.get(o) || 0) + 1);
  }
  let bestO = 0;
  let bestC = 0;
  for (const [o, c] of offsetCounts) {
    if (c > bestC) {
      bestO = o;
      bestC = c;
    }
  }
  const agreement = bestC / usable.length;
  otelLog.info("page-offset calibration", {
    scope: "pdf",
    samples: samples.slice(0, 20),
    offsetHistogram: [...offsetCounts.entries()].sort((a, b) => b[1] - a[1]),
    agreement,
    chosen: agreement >= 0.8 ? bestO : null,
  });

  if (agreement >= 0.8) {
    return { pageOffset: bestO, agreement, samples };
  }
  if (agreement >= 0.5) {
    otelLog.info(
      "page-offset agreement 50–80% — shipping page=null (fail closed)",
      { scope: "pdf", agreement },
    );
  }
  return { pageOffset: null, agreement, samples };
}

export async function parsePdf(file: File): Promise<ParseResult> {
  const isNode = typeof window === "undefined";
  // Legacy build for Node (DOMMatrix); standard build for the browser.
  const pdfjs = isNode
    ? await import("pdfjs-dist/legacy/build/pdf.mjs")
    : await import("pdfjs-dist");
  if (!isNode) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
  }

  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({
    data,
    ...(isNode ? { useSystemFonts: true, disableWorker: true } : {}),
  }).promise;
  const numPages = doc.numPages;

  // Scan guard: sample 5 pages
  const sampleIdx = Array.from(
    { length: Math.min(5, numPages) },
    (_, i) => Math.floor((i * numPages) / Math.min(5, numPages)) + 1,
  );
  let totalChars = 0;
  for (const p of sampleIdx) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    totalChars += content.items
      .map((it) => ("str" in it ? it.str : ""))
      .join("").length;
  }
  if (totalChars / sampleIdx.length < 100) {
    otelLog.error("PDF looks like a scan, rejecting", {
      scope: "pdf",
      avgCharsPerSample: totalChars / sampleIdx.length,
    });
    throw new Error(
      "This PDF looks like a scan (too little extractable text). OCR is required — aborting.",
    );
  }

  const allLines: Line[] = [];

  for (let p = 1; p <= numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items: TextItem[] = content.items
      .filter(
        (it): it is typeof it & { str: string; transform: number[] } =>
          "str" in it && "transform" in it,
      )
      .map((it) => ({
        str: it.str,
        transform: it.transform as number[],
        width: "width" in it ? (it.width as number) : 0,
        height:
          "height" in it
            ? (it.height as number)
            : (it.transform[0] as number) || 10,
        fontName: "fontName" in it ? String(it.fontName) : "",
      }));
    allLines.push(...buildLines(items, p - 1, viewport.height));
  }

  // Running heads/feet + page number candidates
  const headFootCounts = new Map<string, number>();
  const pageNumSamples: { pdfPage: number; printed: number }[] = [];

  for (const line of allLines) {
    const top = line.y > line.pageHeight * 0.92;
    const bottom = line.y < line.pageHeight * 0.08;
    if (!top && !bottom) continue;
    const key = line.text.replace(/\d+/g, "").replace(/\s+/g, " ").trim();
    if (key.length >= 3) {
      headFootCounts.set(key, (headFootCounts.get(key) || 0) + 1);
    }
    const m = line.text.match(/\b(\d{1,4})\b/);
    if (m) {
      pageNumSamples.push({
        pdfPage: line.pageIndex,
        printed: parseInt(m[1]!, 10),
      });
    }
  }

  const threshold = numPages * 0.3;
  const dropKeys = new Set(
    [...headFootCounts.entries()]
      .filter(([, c]) => c > threshold)
      .map(([k]) => k),
  );

  const filtered = allLines.filter((l) => {
    const top = l.y > l.pageHeight * 0.92;
    const bottom = l.y < l.pageHeight * 0.08;
    if (!top && !bottom) return true;
    const key = l.text.replace(/\d+/g, "").replace(/\s+/g, " ").trim();
    return !dropKeys.has(key);
  });

  const {
    pageOffset,
    agreement: pageOffsetAgreement,
    samples: pageOffsetSamples,
  } = calibratePageOffset(pageNumSamples, numPages);

  const bodySize =
    mode(
      filtered.map((l) => l.height),
      0.25,
    ) ?? 10;

  const deltas: number[] = [];
  const xStarts: number[] = [];
  const byPage = new Map<number, Line[]>();
  for (const l of filtered) {
    const arr = byPage.get(l.pageIndex) || [];
    arr.push(l);
    byPage.set(l.pageIndex, arr);
    xStarts.push(l.xStart);
  }
  for (const lines of byPage.values()) {
    const sorted = [...lines].sort((a, b) => b.y - a.y);
    for (let i = 1; i < sorted.length; i++) {
      deltas.push(sorted[i - 1]!.y - sorted[i]!.y);
    }
  }
  const lineSpacing = mode(deltas, 0.5) ?? bodySize * 1.4;
  const leftMargin = mode(xStarts, 2) ?? 0;

  const pageWidth = Math.max(...filtered.map((l) => l.xStart + 100), 600);
  const midGap = pageWidth * 0.1;
  const leftXs = xStarts.filter((x) => x < pageWidth * 0.45);
  const rightXs = xStarts.filter((x) => x > pageWidth * 0.55);
  const twoCol =
    leftXs.length > 20 &&
    rightXs.length > 20 &&
    (mode(rightXs, 5) ?? 0) - (mode(leftXs, 5) ?? 0) > midGap;

  // Heading size histogram for calibration
  const heightCounts = new Map<number, number>();
  for (const l of filtered) {
    const h = Math.round(l.height * 4) / 4;
    heightCounts.set(h, (heightCounts.get(h) || 0) + 1);
  }
  const headingSizeHistogram = [...heightCounts.entries()]
    .filter(([h]) => h >= 1.1 * bodySize)
    .map(([height, count]) => ({ height, count }))
    .sort((a, b) => b.height - a.height);

  let paragraphs: ParagraphUnit[] = [];
  let paraIndex = 0;
  let chapterIndex: number | null = null;
  let chapterTitle: string | null = null;
  let sectionTitle: string | null = null;

  for (let p = 0; p < numPages; p++) {
    let pageLines = byPage.get(p) || [];
    if (twoCol) {
      const mid = pageWidth * 0.5;
      const left = pageLines
        .filter((l) => l.xStart < mid)
        .sort((a, b) => b.y - a.y);
      const right = pageLines
        .filter((l) => l.xStart >= mid)
        .sort((a, b) => b.y - a.y);
      pageLines = [...left, ...right];
    } else {
      pageLines = [...pageLines].sort((a, b) => b.y - a.y);
    }

    pageLines = mergeHeadingCandidates(pageLines, bodySize, lineSpacing);
    const classified = classifyPageLines(pageLines, bodySize);

    const printedPage = pageOffset != null ? p + pageOffset : null;
    let buf: string[] = [];
    let prev: Line | null = null;
    let prevWasHeading = false;

    const flushPara = (kind: ParagraphUnit["blockKind"] = "body") => {
      if (!buf.length) return;
      const joined = dehyphenate(buf).join(" ").replace(/\s+/g, " ").trim();
      buf = [];
      if (!joined) return;
      if (isStubParagraph(joined)) return;
      paragraphs.push({
        paraIndex: paraIndex++,
        chapterIndex,
        chapterTitle,
        sectionTitle,
        page: printedPage,
        blockKind: kind,
        text: joined,
      });
    };

    for (const line of classified) {
      if (line.role === "chapterHeading" || line.role === "sectionHeading") {
        flushPara();
        if (line.role === "chapterHeading") {
          chapterIndex = (chapterIndex ?? 0) + 1;
          chapterTitle = line.text;
          sectionTitle = null;
        } else {
          sectionTitle = line.text;
        }
        if (!isStubParagraph(line.text)) {
          paragraphs.push({
            paraIndex: paraIndex++,
            chapterIndex,
            chapterTitle,
            sectionTitle,
            page: printedPage,
            blockKind: "heading",
            text: line.text,
          });
        }
        prevWasHeading = true;
        prev = line;
        continue;
      }

      const shouldBreak =
        prevWasHeading ||
        (prev != null &&
          (prev.y - line.y > 1.4 * lineSpacing ||
            line.xStart > leftMargin + 8 ||
            (/[.!?]["']?$/.test(prev.text) &&
              prev.y - line.y > 1.15 * lineSpacing)));

      if (shouldBreak && buf.length) flushPara();
      buf.push(line.text);
      prevWasHeading = false;
      prev = line;
    }
    flushPara();
  }

  paragraphs = demoteSmallChapters(paragraphs);

  // Chapter sanity gate
  const chapterCounts = new Map<number, { title: string; count: number }>();
  for (const p of paragraphs) {
    if (p.chapterIndex == null) continue;
    const cur = chapterCounts.get(p.chapterIndex) ?? {
      title: p.chapterTitle ?? "",
      count: 0,
    };
    cur.count++;
    if (p.chapterTitle) cur.title = p.chapterTitle;
    chapterCounts.set(p.chapterIndex, cur);
  }
  const chapterCount = chapterCounts.size;
  const chapters = [...chapterCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([chapterIndex, v]) => ({
      chapterIndex,
      title: v.title,
      paragraphCount: v.count,
    }));

  otelLog.info("calibration", {
    scope: "pdf",
    bodySize,
    lineSpacing,
    pageOffset,
    chapterCount,
    chapters: JSON.stringify(chapters),
    headingSizeHistogram: JSON.stringify(headingSizeHistogram),
  });

  if (chapterCount > 40 || chapterCount < 5) {
    otelLog.error("chapter detection gate failed", {
      scope: "pdf",
      chapterCount,
    });
    throw new Error(
      `Chapter detection failed: ${chapterCount} chapters. ` +
        `Expected 5-40. Tune heading thresholds before ingesting. ` +
        `Detected: ${chapters.map((c) => `${c.chapterIndex}:${c.title}(${c.paragraphCount})`).join("; ")}`,
    );
  }

  const calibration: ParseCalibration = {
    bodySize,
    lineSpacing,
    pageOffset,
    pageOffsetAgreement,
    pageOffsetSamples,
    headingSizeHistogram,
    chapters,
  };

  const meta = await doc.getMetadata().catch(() => null);
  const info = (meta?.info || {}) as Record<string, string>;

  return {
    title: info.Title || file.name.replace(/\.pdf$/i, ""),
    authors: info.Author ? [info.Author] : ["Unknown"],
    sourceFormat: "pdf",
    structureConf: "medium",
    pageOffset,
    pageCount: numPages,
    paragraphs:
      pageOffset == null
        ? paragraphs.map((p) => ({ ...p, page: null }))
        : paragraphs,
    calibration,
  };
}
