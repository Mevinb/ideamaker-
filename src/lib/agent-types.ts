export const AGENT_ROLES = ["Coordinator", ...Array.from({ length: 8 }, (_, i) => `Explorer ${i + 1}`), "Originality reviewer", "Taste reviewer", "Feasibility reviewer", "Editor"];
export type Concept = {
  id: string; title: string; problem: string; mechanism: string; interaction: string;
  output: string; moment: string; prototype: string; uncertainties: string;
  explorer: number; revision: number;
};
export type Review = { id: string; duplicateOf: string | null; cluster: string; surprise: number; taste: number; violatesConstraints: boolean; reason: string };
export type TasteFeedback = { id: number; runId: string; conceptId: string; kind: "more" | "familiar" | "wrong"; reason: string; concept: Concept };
export type ExplorationState = {
  round: number; attempts: number; startedAt: number; done: boolean; cycle: number;
  tasks: Record<string, unknown>; candidates: Concept[]; reviews: Review[]; shortlist: Concept[];
  selectedId?: string; directionVersion?: number;
};
