import { NextRequest, NextResponse } from "next/server";
import { appendEvent, getEvents, getRun, updateRun, getExploration, hasLease } from "@/lib/db";
import { stopExploration } from "@/lib/exploration";

export const runtime = "nodejs";

export async function GET(_: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  return NextResponse.json({ run, events: getEvents(id), exploration: getExploration(id), recoverable: run.settings.workflow === "exploration-v1" && !hasLease(id) && run.status !== "completed" });
}

export async function DELETE(_: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  if (run.status === "completed" || run.status === "failed") return NextResponse.json({ run });
  updateRun(id, { status: "cancelled", stage: "Cancelling" });
  stopExploration(id);
  appendEvent(id, "status", run.mode === "chat" ? "Stop requested" : "Cancellation requested", "Cancelling");
  return NextResponse.json({ run: getRun(id) });
}
