export type Preset = "general" | "hackathon" | "startup" | "creative" | "personal";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type RunEvent = {
  id: number;
  runId: string;
  kind: "status" | "progress" | "warning" | "error" | "message";
  message: string;
  stage?: string;
  createdAt: string;
};

export type RunSettings = {
  workflow?: "exploration-v1" | "group-chat-v1";
  agentModels?: Record<string, string>;
  models: {
    analyzer: string;
    generators: string[];
    filter: string;
    critic: string;
    mutation: string;
    jury: string[];
  };
  noveltySearch: boolean;
  continuous?: boolean;
};

export type Brief = {
  goal: string;
  audience: string;
  tone: string[];
  constraints: Record<string, string | number | boolean>;
  avoid: string[];
  priorities: string[];
  assumptions: string[];
};

export type IdeaGenome = {
  interaction: string;
  input: string;
  output: string;
  humor_or_hook: string;
  complexity: "low" | "medium" | "high";
  technologies: string[];
};

export type Candidate = {
  id: string;
  title: string;
  oneLiner: string;
  concept: string;
  demo: string;
  buildPlan: string[];
  risks: string[];
  genome: IdeaGenome;
  generatorSlot: number;
  generatorModel?: string;
  modelAttribution?: string;
  parentId?: string;
  preliminary?: MetricScores;
  cluster?: string;
  evidence?: Evidence[];
  debate?: DebateRecord;
  mutation?: MutationRecord;
};

export type MetricScores = {
  originality: number;
  feasibility: number;
  demoImpact: number;
  constraintFit: number;
  simplicity: number;
  surprise: number;
};

export type Evidence = {
  url: string;
  title: string;
  snippet: string;
  query: string;
  risk: "low" | "medium" | "high" | "unknown";
};

export type DebateRecord = {
  models?: { opening?: string; rebuttal?: string; critic: string };
  opponentId?: string;
  opening: string;
  rebuttal: string;
  critic: string;
};

export type MutationRecord = {
  changes: string[];
  rationale: string;
  unresolvedRisks: string[];
};

export type JudgeScore = MetricScores & {
  model?: string;
  ideaId: string;
  rationale: string;
};

export type FinalCandidate = Candidate & {
  finalScore: number;
  judgeScores: JudgeScore[];
  average: MetricScores;
  eligible: boolean;
  ineligibilityReason?: string;
};

export type TournamentResult = {
  brief: Brief;
  initialCandidates: Candidate[];
  eliminated: { candidate: Candidate; reason: string }[];
  finalists: FinalCandidate[];
  winner?: FinalCandidate;
  completedAt: string;
  externalResearchEnabled: boolean;
};

export type Run = {
  id: string;
  prompt: string;
  preset: Preset;
  settings: RunSettings;
  status: RunStatus;
  stage: string;
  createdAt: string;
  updatedAt: string;
  /** Missing on runs created before the conversational workflow. */
  mode?: "tournament" | "chat";
  result?: TournamentResult;
  error?: string;
};

export type ChatMessage = {
  agent?: string;
  detail?: boolean;
  role: "user" | "assistant" | "system";
  participant?: number;
  model?: string;
  content: string;
  round: number;
};

export const DEFAULT_SETTINGS: RunSettings = {
  models: {
    analyzer: "auto",
    generators: ["auto", "auto", "auto", "auto"],
    filter: "auto",
    critic: "auto",
    mutation: "auto",
    jury: ["auto", "auto", "auto"],
  },
  noveltySearch: true,
  continuous: false,
};
