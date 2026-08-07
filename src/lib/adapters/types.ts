export type ParagraphUnit = {
  paraIndex: number;
  chapterIndex: number | null;
  chapterTitle: string | null;
  sectionTitle: string | null;
  page: number | null;
  blockKind: "body" | "heading" | "list" | "quote" | "table";
  text: string;
};

export type ParseCalibration = {
  bodySize: number;
  lineSpacing: number;
  pageOffset: number | null;
  pageOffsetAgreement: number | null;
  pageOffsetSamples: { pdfPageIndex: number; extractedInteger: number; offset: number }[];
  headingSizeHistogram: { height: number; count: number }[];
  chapters: { chapterIndex: number; title: string; paragraphCount: number }[];
};

export type ParseResult = {
  title: string;
  authors: string[];
  sourceFormat: "epub" | "pdf";
  structureConf: "high" | "medium" | "low";
  pageOffset: number | null;
  /** PDF page count when known (for reading progress). */
  pageCount?: number | null;
  paragraphs: ParagraphUnit[];
  calibration?: ParseCalibration;
};
