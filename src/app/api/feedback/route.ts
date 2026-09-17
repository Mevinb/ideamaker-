import { z } from "zod";
import { addTasteFeedback, clearTasteFeedback, getExploration, getTasteFeedback } from "@/lib/db";
export const runtime = "nodejs";
const schema = z.object({ runId: z.string(), conceptId: z.string(), kind: z.enum(["more", "familiar", "wrong"]), reason: z.string().max(2000).default("") });
export async function GET() { return Response.json({ feedback: getTasteFeedback() }); }
export async function DELETE() { clearTasteFeedback(); return Response.json({ cleared: true }); }
export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid feedback" }, { status: 400 });
  const concept = getExploration(parsed.data.runId)?.candidates.find(c => c.id === parsed.data.conceptId);
  if (!concept) return Response.json({ error: "Concept not found" }, { status: 404 });
  addTasteFeedback({ ...parsed.data, concept }); return Response.json({ saved: true }, { status: 201 });
}
