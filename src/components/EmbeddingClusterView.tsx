"use client";

import * as d3 from "d3";
import { useEffect, useMemo, useRef, useState } from "react";

type Point = {
  claimId: string;
  statement: string;
  clusterId: string | null;
  projX: number;
  projY: number;
  superseded: string | null;
};

type Neighbor = {
  claimId: string;
  statement: string;
  score: number;
  superseded: string | null;
};

/** Monochrome + one accent. Dedupe clusters are ~1 claim each here — not a color axis. */
const COLOR = {
  base: "#6b7280",
  focus: "#a78bfa",
  neighbor: "#c4b5fd",
  dim: "#2a2d35",
};

const W = 900;
const H = 420;
const PAD = 36;

function truncate(s: string, n: number) {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

export function EmbeddingClusterView({ bookId }: { bookId: string }) {
  const [points, setPoints] = useState<Point[]>([]);
  const [neighbors, setNeighbors] = useState<Neighbor[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [neighborsLoading, setNeighborsLoading] = useState(false);

  const svgRef = useRef<SVGSVGElement>(null);
  const rootRef = useRef<d3.Selection<
    SVGGElement,
    unknown,
    null,
    undefined
  > | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const scalesRef = useRef<{
    x: d3.ScaleLinear<number, number>;
    y: d3.ScaleLinear<number, number>;
  } | null>(null);
  const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetch(`/api/books/${bookId}/embeddings`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setPoints(data.points || []);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  const focusPoint = points.find((p) => p.claimId === focusId) ?? null;

  const visible = useMemo(
    () =>
      showSuperseded ? points : points.filter((p) => p.superseded == null),
    [points, showSuperseded],
  );

  const neighborIds = useMemo(
    () => new Set(neighbors.map((n) => n.claimId)),
    [neighbors],
  );

  useEffect(() => {
    if (!focusId) {
      setNeighbors([]);
      setNeighborsLoading(false);
      return;
    }
    let cancelled = false;
    setNeighborsLoading(true);
    setNeighbors([]);
    void fetch(
      `/api/books/${bookId}/embeddings?focus=${encodeURIComponent(focusId)}`,
    )
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setNeighbors(data.neighbors || []);
        setNeighborsLoading(false);
      })
      .catch(() => {
        if (!cancelled) setNeighborsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, focusId]);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || !visible.length) return;

    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();

    const xs = visible.map((p) => p.projX);
    const ys = visible.map((p) => p.projY);
    const x = d3
      .scaleLinear()
      .domain(d3.extent(xs) as [number, number])
      .nice()
      .range([PAD, W - PAD]);
    const y = d3
      .scaleLinear()
      .domain(d3.extent(ys) as [number, number])
      .nice()
      .range([H - PAD, PAD]);
    scalesRef.current = { x, y };

    const root = svg.append("g").attr("class", "zoom-root");
    rootRef.current = root;

    root
      .append("rect")
      .attr("width", W)
      .attr("height", H)
      .attr("fill", "transparent")
      .style("cursor", "grab")
      .on("click", () => setFocusId(null));

    root.append("g").attr("class", "points");

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 12])
      .on("zoom", (event) => {
        transformRef.current = event.transform;
        root.attr("transform", event.transform.toString());
      });
    zoomRef.current = zoom;
    svg.call(zoom);
    svg.call(zoom.transform, transformRef.current);

    return () => {
      svg.on(".zoom", null);
      rootRef.current = null;
      zoomRef.current = null;
      scalesRef.current = null;
    };
  }, [visible]);

  useEffect(() => {
    const root = rootRef.current;
    const scales = scalesRef.current;
    if (!root || !scales || !visible.length) return;
    const { x, y } = scales;

    root
      .select<SVGGElement>("g.points")
      .selectAll<SVGCircleElement, Point>("circle")
      .data(visible, (d) => d.claimId)
      .join(
        (enter) =>
          enter
            .append("circle")
            .attr("cx", (d) => x(d.projX))
            .attr("cy", (d) => y(d.projY))
            .attr("cursor", "pointer")
            .on("mouseenter", function (_event, d) {
              setHoverId(d.claimId);
              d3.select(this).raise();
            })
            .on("mouseleave", () => setHoverId(null))
            .on("click", (event, d) => {
              event.stopPropagation();
              setFocusId((prev) => (prev === d.claimId ? null : d.claimId));
            }),
        (update) => update,
        (exit) => exit.remove(),
      )
      .attr("r", (d) => {
        if (d.claimId === focusId) return 6.5;
        if (neighborIds.has(d.claimId)) return 5;
        return 3.2;
      })
      .attr("fill", (d) => {
        if (!focusId) return COLOR.base;
        if (d.claimId === focusId) return COLOR.focus;
        if (neighborIds.has(d.claimId)) return COLOR.neighbor;
        return COLOR.dim;
      })
      .attr("fill-opacity", (d) => {
        if (!focusId) return 0.75;
        if (d.claimId === focusId || neighborIds.has(d.claimId)) return 1;
        return 0.12;
      })
      .attr("stroke", (d) => {
        if (d.claimId === focusId) return "#fff";
        if (neighborIds.has(d.claimId)) return "#ddd6fe";
        return "none";
      })
      .attr("stroke-width", (d) => (d.claimId === focusId ? 1.5 : 1));
  }, [visible, focusId, neighborIds]);

  const hoverPoint =
    !focusId && hoverId
      ? (points.find((p) => p.claimId === hoverId) ?? null)
      : null;

  function resetZoom() {
    const svgEl = svgRef.current;
    if (!svgEl || !zoomRef.current) return;
    transformRef.current = d3.zoomIdentity;
    d3.select(svgEl)
      .transition()
      .duration(280)
      .call(zoomRef.current.transform, d3.zoomIdentity);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-xs text-white/45">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={showSuperseded}
            onChange={(e) => setShowSuperseded(e.target.checked)}
          />
          Superseded
        </label>
        <button
          type="button"
          onClick={resetZoom}
          className="rounded-md border border-white/15 px-2 py-0.5 hover:text-white/80"
        >
          Reset view
        </button>
        {focusId ? (
          <button
            type="button"
            onClick={() => setFocusId(null)}
            className="rounded-md border border-white/15 px-2 py-0.5 hover:text-white/80"
          >
            Clear
          </button>
        ) : null}
        <span className="text-white/35">
          {loading
            ? "Loading…"
            : `${visible.length} claims · click to find nearest in embedding space`}
        </span>
      </div>

      <div className="relative overflow-hidden rounded-xl border border-white/10 bg-[#0c0e12]">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="h-[420px] w-full touch-none"
          role="img"
          aria-label="Claim embedding scatter"
        />

        {hoverPoint ? (
          <div className="pointer-events-none absolute bottom-3 left-3 max-w-sm rounded-md border border-white/10 bg-[#12141a]/95 px-2.5 py-1.5 text-[11px] leading-snug text-white/75">
            {truncate(hoverPoint.statement, 140)}
          </div>
        ) : null}

        {focusPoint ? (
          <div className="absolute bottom-3 right-3 top-3 flex w-[min(100%,300px)] flex-col rounded-lg border border-white/12 bg-[#0e1016]/95 shadow-xl backdrop-blur">
            <div className="border-b border-white/8 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] uppercase tracking-wider text-white/40">
                  Focus
                </p>
                <button
                  type="button"
                  onClick={() => setFocusId(null)}
                  className="text-[11px] text-white/40 hover:text-white/70"
                >
                  ✕
                </button>
              </div>
              <p className="mt-1 text-[13px] leading-snug text-white/90">
                {truncate(focusPoint.statement, 160)}
              </p>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
              <p className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/40">
                Nearest
                {neighborsLoading ? (
                  <span className="inline-flex items-center gap-1.5 normal-case tracking-normal text-violet-300/90">
                    <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-violet-300/30 border-t-violet-300" />
                    fetching…
                  </span>
                ) : null}
              </p>

              {neighborsLoading && !neighbors.length ? (
                <div className="space-y-2 py-1">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="h-8 animate-pulse rounded bg-white/5"
                    />
                  ))}
                </div>
              ) : null}

              <ul className="space-y-1.5">
                {neighbors.map((n) => (
                  <li key={n.claimId}>
                    <button
                      type="button"
                      onClick={() => setFocusId(n.claimId)}
                      className="w-full rounded-md px-1.5 py-1 text-left hover:bg-white/5"
                    >
                      <span className="font-mono text-[10px] text-violet-300/90">
                        {n.score.toFixed(2)}
                      </span>
                      <p className="text-[12px] leading-snug text-white/70">
                        {truncate(n.statement, 90)}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>

              {!neighborsLoading && focusId && !neighbors.length ? (
                <p className="text-[12px] text-white/35">None found.</p>
              ) : null}
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0c0e12]/60 text-sm text-white/50">
            Loading projection…
          </div>
        ) : null}
      </div>
    </div>
  );
}
