"use client";

import { useEffect, useState } from "react";
import { ConceptGraph } from "@/components/ConceptGraph";

type GraphPayload = {
  nodes: Parameters<typeof ConceptGraph>[0]["nodes"];
  edges: Parameters<typeof ConceptGraph>[0]["edges"];
};

/** Isolated so Fast Refresh can't change parent useEffect dep array sizes. */
export function BookGraphTab({
  bookId,
  pipelineLive,
}: {
  bookId: string;
  pipelineLive: boolean;
}) {
  const [graph, setGraph] = useState<GraphPayload | null>(null);

  useEffect(() => {
    let alive = true;
    let poll: ReturnType<typeof setInterval> | undefined;

    const load = async () => {
      const r = await fetch(`/api/books/${bookId}/graph`);
      const d = await r.json();
      if (!alive) return 0;
      const edges = d.edges || [];
      setGraph({ nodes: d.nodes || [], edges });
      return edges.length as number;
    };

    void load().then((edgeCount) => {
      if (!alive || !pipelineLive || edgeCount > 0) return;
      poll = setInterval(() => {
        void load().then((n) => {
          if (n > 0 && poll) {
            clearInterval(poll);
            poll = undefined;
          }
        });
      }, 4000);
    });

    return () => {
      alive = false;
      if (poll) clearInterval(poll);
    };
  }, [bookId, pipelineLive]);

  if (!graph) {
    return <p className="text-sm text-white/40">Loading graph…</p>;
  }

  return (
    <ConceptGraph bookId={bookId} nodes={graph.nodes} edges={graph.edges} />
  );
}
