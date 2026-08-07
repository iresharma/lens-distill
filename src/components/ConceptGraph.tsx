"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ConceptGraphEdge,
  ConceptGraphEdgeKind,
  ConceptGraphNode,
} from "@/lib/load-concept-graph";

type SimNode = ConceptGraphNode & {
  x: number;
  y: number;
  vx: number;
  vy: number;
};

const KIND_META: Record<
  ConceptGraphEdgeKind,
  { label: string; color: string; dashed?: boolean }
> = {
  prerequisite: { label: "Prerequisite", color: "#5e6ad2" },
  related: { label: "Related", color: "#3d9a6a" },
  confusable: { label: "Confusable", color: "#c45c26", dashed: true },
  co_mention: { label: "Co-mentioned", color: "#8a8f98" },
};

/** Keep nodes this far apart (label-friendly). */
const COLLIDE = 42;
const PAD = 56;

function masteryFill(mastery: number | null): string {
  if (mastery == null) return "#3a3d46";
  if (mastery >= 0.7) return "#4cb782";
  if (mastery >= 0.4) return "#e2a336";
  return "#eb5757";
}

function nodeRadius(claimCount: number, active: boolean): number {
  const base = 5 + Math.min(10, Math.sqrt(Math.max(1, claimCount)));
  return active ? base + 2 : base;
}

function seedLayout(
  nodes: ConceptGraphNode[],
  w: number,
  h: number,
): SimNode[] {
  const byChapter = new Map<number | "none", ConceptGraphNode[]>();
  for (const n of nodes) {
    const key = n.primaryChapter ?? "none";
    const list = byChapter.get(key) ?? [];
    list.push(n);
    byChapter.set(key, list);
  }
  const chapters = [...byChapter.keys()].sort((a, b) => {
    if (a === "none") return 1;
    if (b === "none") return -1;
    return a - b;
  });

  // Chapter hubs sit on an *inner* ring so clusters fill the canvas, not the rim.
  const cx = w / 2;
  const cy = h / 2;
  const hubR = Math.min(w, h) * 0.22;
  const seeded: SimNode[] = [];

  chapters.forEach((ch, ci) => {
    const list = byChapter.get(ch)!;
    const hubAngle =
      (ci / Math.max(1, chapters.length)) * Math.PI * 2 - Math.PI / 2;
    const hubX = cx + Math.cos(hubAngle) * hubR;
    const hubY = cy + Math.sin(hubAngle) * hubR;

    // Pack nodes in a small disc around the hub (golden-angle spiral).
    const golden = Math.PI * (3 - Math.sqrt(5));
    list.forEach((n, i) => {
      const t = i + 0.5;
      const r = 12 + Math.sqrt(t) * 16;
      const a = t * golden;
      seeded.push({
        ...n,
        x: hubX + Math.cos(a) * r,
        y: hubY + Math.sin(a) * r,
        vx: 0,
        vy: 0,
      });
    });
  });

  return seeded;
}

export function ConceptGraph({
  bookId,
  nodes,
  edges,
  embed = false,
}: {
  bookId: string;
  nodes: ConceptGraphNode[];
  edges: ConceptGraphEdge[];
  embed?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<SimNode[]>([]);
  const dragRef = useRef<string | null>(null);
  const startDragRelaxationRef = useRef<(() => void) | null>(null);
  const stopDragRelaxationRef = useRef<(() => void) | null>(null);
  const [size, setSize] = useState({ w: 900, h: 640 });
  const [enabled, setEnabled] = useState<Record<ConceptGraphEdgeKind, boolean>>({
    prerequisite: true,
    related: true,
    confusable: true,
    co_mention: true,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [simNodes, setSimNodes] = useState<SimNode[]>([]);

  const activeEdges = useMemo(
    () => edges.filter((e) => enabled[e.kind]),
    [edges, enabled],
  );
  const edgeKey = useMemo(
    () => activeEdges.map((e) => e.id).join("|"),
    [activeEdges],
  );

  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of edges) {
      d.set(e.source, (d.get(e.source) || 0) + 1);
      d.set(e.target, (d.get(e.target) || 0) + 1);
    }
    return d;
  }, [edges]);

  // Top connected nodes always keep a label so the graph stays scannable.
  const alwaysLabel = useMemo(() => {
    return new Set(
      [...degree.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.min(12, nodes.length))
        .map(([id]) => id),
    );
  }, [degree, nodes.length]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(320, r.width), h: Math.max(420, r.height) });
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setSize({ w: Math.max(320, r.width), h: Math.max(420, r.height) });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const { w, h } = size;
    if (w < 40 || h < 40 || !nodes.length) return;

    const seeded = seedLayout(nodes, w, h);
    simRef.current = seeded;
    setSimNodes(seeded.map((n) => ({ ...n })));

    let alive = true;
    let frame = 0;

    const tick = () => {
      if (!alive) return;
      frame++;
      const list = simRef.current;
      const map = new Map(list.map((n) => [n.id, n]));
      // Cool down, but keep a little motion for drag rebalancing.
      const alpha = Math.max(0.015, 0.85 * Math.pow(1 - frame / 320, 2));

      // Link springs — short ideal length keeps clusters compact in the center.
      for (const e of activeEdges) {
        const a = map.get(e.source);
        const b = map.get(e.target);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 1;
        const ideal =
          e.kind === "confusable" ? 70 : e.kind === "prerequisite" ? 95 : 110;
        const f = ((dist - ideal) / dist) * 0.06 * alpha;
        a.vx += dx * f;
        a.vy += dy * f;
        b.vx -= dx * f;
        b.vy -= dy * f;
      }

      // Short-range collision (prevents pile-ups) + mild long-range charge.
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]!;
          const b = list[j]!;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist = Math.hypot(dx, dy);
          if (dist < 0.01) {
            dx = (Math.random() - 0.5) * 2;
            dy = (Math.random() - 0.5) * 2;
            dist = Math.hypot(dx, dy);
          }
          if (dist < COLLIDE) {
            const push = ((COLLIDE - dist) / dist) * 0.5 * alpha;
            a.vx -= dx * push;
            a.vy -= dy * push;
            b.vx += dx * push;
            b.vy += dy * push;
          } else if (dist < 220) {
            const f = (180 * alpha) / (dist * dist);
            a.vx -= dx * f;
            a.vy -= dy * f;
            b.vx += dx * f;
            b.vy += dy * f;
          }
        }
      }

      const cx = w / 2;
      const cy = h / 2;
      for (const n of list) {
        if (dragRef.current === n.id) {
          n.vx = 0;
          n.vy = 0;
          continue;
        }

        // Pull toward center — stronger than the old layout so nodes don't flee to rims.
        n.vx += (cx - n.x) * 0.012 * alpha;
        n.vy += (cy - n.y) * 0.012 * alpha;

        // Soft walls: push inward before hitting the edge (no hard clamp pile-up).
        if (n.x < PAD) n.vx += (PAD - n.x) * 0.08;
        if (n.x > w - PAD) n.vx -= (n.x - (w - PAD)) * 0.08;
        if (n.y < PAD) n.vy += (PAD - n.y) * 0.08;
        if (n.y > h - PAD) n.vy -= (n.y - (h - PAD)) * 0.08;

        n.vx *= 0.78;
        n.vy *= 0.78;
        n.x += n.vx;
        n.y += n.vy;

        // Soft clamp as last resort — keep a generous inset.
        n.x = Math.min(w - PAD * 0.6, Math.max(PAD * 0.6, n.x));
        n.y = Math.min(h - PAD * 0.6, Math.max(PAD * 0.6, n.y));
      }

      if (frame % 2 === 0) {
        setSimNodes(list.map((n) => ({ ...n })));
      }
      if (frame < 360 || dragRef.current) {
        requestAnimationFrame(tick);
      } else {
        setSimNodes(list.map((n) => ({ ...n })));
      }
    };

    requestAnimationFrame(tick);
    return () => {
      alive = false;
    };
    // edgeKey captures filter changes without new array identity thrash
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, size.w, size.h, edgeKey]);

  // Relax neighbors only while dragging; do no animation work while idle.
  useEffect(() => {
    let raf: number | null = null;
    const w = size.w;
    const h = size.h;

    const pump = () => {
      if (dragRef.current) {
        // nudge a few collision iterations using latest simRef
        const list = simRef.current;
        for (let k = 0; k < 3; k++) {
          for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
              const a = list[i]!;
              const b = list[j]!;
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const dist = Math.hypot(dx, dy) || 1;
              if (dist < COLLIDE) {
                const push = ((COLLIDE - dist) / dist) * 0.35;
                if (dragRef.current !== a.id) {
                  a.x -= dx * push;
                  a.y -= dy * push;
                }
                if (dragRef.current !== b.id) {
                  b.x += dx * push;
                  b.y += dy * push;
                }
              }
            }
          }
        }
        for (const n of list) {
          n.x = Math.min(w - PAD * 0.6, Math.max(PAD * 0.6, n.x));
          n.y = Math.min(h - PAD * 0.6, Math.max(PAD * 0.6, n.y));
        }
        setSimNodes(list.map((n) => ({ ...n })));
        raf = requestAnimationFrame(pump);
      } else {
        raf = null;
      }
    };

    const start = () => {
      if (raf == null && dragRef.current) {
        raf = requestAnimationFrame(pump);
      }
    };
    const stop = () => {
      if (raf != null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
    };

    startDragRelaxationRef.current = start;
    stopDragRelaxationRef.current = stop;
    start();

    return () => {
      stop();
      startDragRelaxationRef.current = null;
      stopDragRelaxationRef.current = null;
    };
  }, [size.w, size.h]);

  const simNodeById = useMemo(() => {
    const byId = new Map<string, SimNode>();
    for (const node of simNodes) {
      if (!byId.has(node.id)) byId.set(node.id, node);
    }
    return byId;
  }, [simNodes]);
  const selectedNode = selected ? simNodeById.get(selected) || null : null;
  const focus = hover || selected;
  const neighborIds = useMemo(() => {
    if (!focus) return new Set<string>();
    const s = new Set<string>([focus]);
    for (const e of activeEdges) {
      if (e.source === focus) s.add(e.target);
      if (e.target === focus) s.add(e.source);
    }
    return s;
  }, [focus, activeEdges]);

  function showLabel(id: string) {
    if (focus) return neighborIds.has(id) || id === focus;
    return alwaysLabel.has(id);
  }

  return (
    <div className={embed ? "flex h-dvh flex-col bg-[#0b0c0e]" : "space-y-3"}>
      <div
        className={`flex flex-wrap items-center gap-2 ${embed ? "border-b border-white/10 px-3 py-2" : ""}`}
      >
        {(Object.keys(KIND_META) as ConceptGraphEdgeKind[]).map((kind) => {
          const meta = KIND_META[kind];
          const count = edges.filter((e) => e.kind === kind).length;
          // co_mention unused here; always show prereq/related/confusable toggles
          if (kind === "co_mention") return null;
          return (
            <button
              key={kind}
              type="button"
              onClick={() =>
                setEnabled((prev) => ({ ...prev, [kind]: !prev[kind] }))
              }
              className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
                enabled[kind]
                  ? "border-transparent text-white"
                  : "border-white/15 bg-transparent text-white/45 opacity-60"
              }`}
              style={
                enabled[kind] ? { backgroundColor: meta.color } : undefined
              }
            >
              {meta.label} · {count}
            </button>
          );
        })}
        <span className="text-[11px] text-white/50">
          {nodes.length} concepts · {edges.length} edges · hover for labels ·
          drag to rearrange
        </span>
      </div>

      <div
        ref={wrapRef}
        className={`relative overflow-hidden rounded-xl border ${
          embed
            ? "min-h-0 flex-1 border-0"
            : "h-[min(72vh,760px)] border-white/10 bg-[#0f1114]"
        }`}
      >
        <svg width={size.w} height={size.h} className="block touch-none">
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="18"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#5e6ad2" />
            </marker>
          </defs>

          {activeEdges.map((e) => {
            const a = simNodeById.get(e.source);
            const b = simNodeById.get(e.target);
            if (!a || !b) return null;
            const meta = KIND_META[e.kind];
            const dim = focus && focus !== e.source && focus !== e.target;
            return (
              <line
                key={e.id}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={meta.color}
                strokeWidth={e.kind === "co_mention" ? 1 : 1.6}
                strokeOpacity={
                  dim
                    ? 0.06
                    : e.kind === "related" || e.kind === "co_mention"
                      ? 0.2
                      : 0.55
                }
                strokeDasharray={meta.dashed ? "4 3" : undefined}
                markerEnd={
                  e.kind === "prerequisite" ? "url(#arrow)" : undefined
                }
              />
            );
          })}

          {simNodes.map((n) => {
            const dim = !!(focus && !neighborIds.has(n.id) && focus !== n.id);
            const active = selected === n.id || hover === n.id;
            const fill = masteryFill(n.mastery);
            const r = nodeRadius(n.claimCount ?? 1, active);
            const label = showLabel(n.id);
            return (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                style={{ cursor: "pointer" }}
                opacity={dim ? 0.16 : 1}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onClick={() =>
                  setSelected((prev) => (prev === n.id ? null : n.id))
                }
                onPointerDown={(ev) => {
                  ev.currentTarget.setPointerCapture?.(ev.pointerId);
                  dragRef.current = n.id;
                  startDragRelaxationRef.current?.();
                }}
                onPointerMove={(ev) => {
                  if (dragRef.current !== n.id) return;
                  const rect = wrapRef.current?.getBoundingClientRect();
                  if (!rect) return;
                  const node = simRef.current.find((p) => p.id === n.id);
                  if (!node) return;
                  node.x = Math.min(
                    size.w - PAD * 0.6,
                    Math.max(PAD * 0.6, ev.clientX - rect.left),
                  );
                  node.y = Math.min(
                    size.h - PAD * 0.6,
                    Math.max(PAD * 0.6, ev.clientY - rect.top),
                  );
                  node.vx = 0;
                  node.vy = 0;
                }}
                onPointerUp={() => {
                  dragRef.current = null;
                  stopDragRelaxationRef.current?.();
                }}
                onPointerCancel={() => {
                  dragRef.current = null;
                  stopDragRelaxationRef.current?.();
                }}
              >
                <circle
                  r={r}
                  fill={fill}
                  stroke={active ? "#fff" : "rgba(255,255,255,0.28)"}
                  strokeWidth={active ? 2 : 1}
                />
                {label ? (
                  <text
                    y={r + 12}
                    textAnchor="middle"
                    fill="rgba(255,255,255,0.92)"
                    fontSize={active ? 11 : 10}
                    fontWeight={active ? 600 : 500}
                    style={{ pointerEvents: "none", userSelect: "none" }}
                  >
                    {n.label.length > 24 ? `${n.label.slice(0, 22)}…` : n.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>

        {selectedNode ? (
          <div className="absolute bottom-3 left-3 right-3 rounded-xl border border-white/10 bg-[#14161a]/95 p-3 text-white shadow-xl backdrop-blur sm:left-auto sm:w-80">
            <p className="text-[11px] uppercase tracking-wide text-white/50">
              Reference · {selectedNode.claimCount ?? 0} claims
              {selectedNode.mastery != null
                ? ` · ${Math.round(selectedNode.mastery * 100)}% retention`
                : ""}
            </p>
            <p className="mt-0.5 text-base font-semibold tracking-tight">
              {selectedNode.label}
            </p>
            <p className="mt-1 text-[13px] leading-snug text-white/75">
              {selectedNode.oneLiner}
            </p>
            <p className="mt-2 text-[11px] text-white/45">
              Edges from the concept_graph stage — prerequisite, related, confusable.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                href={`/books/${encodeURIComponent(bookId)}?tab=claims&concept=${encodeURIComponent(selectedNode.id)}`}
                className="rounded-lg bg-white px-3 py-1.5 text-[12px] font-semibold text-[#0a0a0b]"
              >
                View claims
              </Link>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-lg border border-white/15 px-3 py-1.5 text-[12px] text-white/80"
              >
                Dismiss
              </button>
            </div>
            {activeEdges
              .filter(
                (e) =>
                  e.source === selectedNode.id || e.target === selectedNode.id,
              )
              .slice(0, 6)
              .map((e) => {
                const other =
                  e.source === selectedNode.id ? e.target : e.source;
                const otherNode = simNodeById.get(other);
                return (
                  <p key={e.id} className="mt-2 text-[11px] text-white/55">
                    <span style={{ color: KIND_META[e.kind].color }}>
                      {KIND_META[e.kind].label}
                    </span>
                    {" → "}
                    {otherNode?.label || other}
                    {e.label ? ` — ${e.label}` : ""}
                  </p>
                );
              })}
          </div>
        ) : null}
      </div>

      {!embed ? (
        <p className="text-[12px] text-white/45">
          Node size = claim count. Prerequisite edges directed; confusable
          dashed. Book <code className="text-white/70">{bookId}</code>.
        </p>
      ) : null}
    </div>
  );
}
