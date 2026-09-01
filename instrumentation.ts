export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startOtel } = await import("@/lib/otel/sdk");
  await startOtel();
}
