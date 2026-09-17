import { after } from "next/server";
import { z } from "zod";
import { addUserMessage, runChatRound } from "@/lib/chat";
import { getRun, appendEvent, getExploration, hasLease, updateRun } from "@/lib/db";
import { runExploration } from "@/lib/exploration";

export const runtime = "nodejs";

const inputSchema = z.object({ content: z.string().trim().min(1).max(15_000), selectedConceptId: z.string().optional(), resume: z.boolean().optional() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Write a message before sending it." }, { status: 400 });
  if (!getRun(id)) return Response.json({ error: "Conversation not found." }, { status: 404 });
  try {
    const run = getRun(id)!;
    if (run.settings.workflow === "exploration-v1") {
      const state = getExploration(id);
      if (parsed.data.selectedConceptId && !state?.candidates.some(c => c.id === parsed.data.selectedConceptId)) return Response.json({ error: "Unknown concept" }, { status: 400 });
      if (!parsed.data.resume) appendEvent(id, "message", JSON.stringify({ role: "user", content: parsed.data.content, selectedConceptId: parsed.data.selectedConceptId, round: (state?.round ?? 0) + (state?.done ? 1 : 0) }));
      const queued = !hasLease(id);
      if (queued) { updateRun(id, { status: "queued", stage: "Queued for exploration", error: "" }); after(() => runExploration(id)); }
      return Response.json({ run: getRun(id), queued }, { status: 201 });
    }
    const { queued } = addUserMessage(id, parsed.data.content);
    if (queued) after(() => runChatRound(id));
    return Response.json({ run: getRun(id), queued }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not save the message." }, { status: 409 });
  }
}
