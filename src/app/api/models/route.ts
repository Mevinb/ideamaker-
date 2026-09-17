import { NextResponse } from "next/server";
import { availableModels } from "@/lib/omniroute";

export const runtime = "nodejs";

export async function GET() {
  try { return NextResponse.json({ models: await availableModels(), connected: true }); }
  catch (error) { return NextResponse.json({ models: [], connected: false, error: `Cannot reach OmniRoute. Start omniroute and check OMNIROUTE_BASE_URL in .env.local. ${error instanceof Error ? error.message : "Gateway unavailable"}` }); }
}
