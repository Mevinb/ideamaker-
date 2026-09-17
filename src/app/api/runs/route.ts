import { randomUUID } from "node:crypto";
import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createRun, listRuns } from "@/lib/db";
import { addUserMessage, runChatRound } from "@/lib/chat";
import { DEFAULT_SETTINGS } from "@/lib/types";
import { availableModels } from "@/lib/omniroute";
import { resolveAutoModels } from "@/lib/model-assignments";

const model = z.string().trim().min(1).max(200);
const inputSchema = z.object({
  prompt: z.string().trim().min(12).max(15_000),
  preset: z.enum(["general", "hackathon", "startup", "creative", "personal"]).default("general"),
  settings: z.object({ models: z.object({ analyzer: model, filter: model, critic: model, mutation: model,
    generators: z.array(model).length(4), jury: z.array(model).length(3) }), noveltySearch: z.boolean(), continuous: z.boolean().optional(), agentModels: z.record(z.string(), model).optional() }).default(DEFAULT_SETTINGS),
});

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ runs: listRuns() });
}

export async function POST(request: NextRequest) {
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ") }, { status: 400 });
  const { prompt, preset, settings } = parsed.data;
  let resolvedSettings;
  try {
    const available = new Set((await availableModels()).map(model => model.id));
    if (!available.size) return NextResponse.json({ error: "No available models. Refresh OmniRoute and retry." }, { status: 503 });
    const invalid = Object.values(settings.models).flat().filter(model => model !== "auto" && !available.has(model));
    if (invalid.length) return NextResponse.json({ error: `Choose available models for every role before starting. Unavailable selections: ${[...new Set(invalid)].join(", ")}` }, { status: 400 });
    resolvedSettings = resolveAutoModels(settings, [...available], true);
    resolvedSettings.continuous = settings.continuous ?? false;
    resolvedSettings.workflow = "group-chat-v1";
    resolvedSettings.noveltySearch = false;
    delete resolvedSettings.agentModels;
  } catch { return NextResponse.json({ error: "Cannot verify account model availability. Refresh OmniRoute model/quota data and retry." }, { status: 503 }); }
  const id = randomUUID();
  const run = createRun(id, prompt, preset, resolvedSettings, "chat");
  addUserMessage(id, prompt);
  after(() => runChatRound(id));
  return NextResponse.json({ run }, { status: 201 });
}
