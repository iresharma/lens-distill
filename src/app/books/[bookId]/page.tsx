import { Suspense } from "react";
import { BookClient } from "./BookClient";

export default async function BookPage({
  params,
}: {
  params: Promise<{ bookId: string }>;
}) {
  const { bookId } = await params;
  return (
    <Suspense fallback={<p className="text-white/50">Loading…</p>}>
      <BookClient bookId={bookId} />
    </Suspense>
  );
}
