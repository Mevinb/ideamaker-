import { getEvents, getRun } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!getRun(id)) return new Response("Run not found", { status: 404 });
  const encoder = new TextEncoder();
  const after = Math.max(0, Number(request.headers.get("last-event-id") || new URL(request.url).searchParams.get("after") || "0") || 0);
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let cursor = after;
      let closed = false;
      const close = () => { if (!closed) { closed = true; clearInterval(timer); request.signal.removeEventListener("abort", close); controller.close(); } };
      const send = () => {
        if (closed) return;
        const events = getEvents(id, cursor);
        for (const event of events) { cursor = event.id; controller.enqueue(encoder.encode(`id: ${event.id}\nevent: run\ndata: ${JSON.stringify(event)}\n\n`)); }
        const run = getRun(id);
        if (!run || ["completed", "failed", "cancelled"].includes(run.status)) close();
      };
      const timer = setInterval(send, 1000);
      cleanup = () => { closed = true; clearInterval(timer); request.signal.removeEventListener("abort", close); };
      request.signal.addEventListener("abort", close);
      send();
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
