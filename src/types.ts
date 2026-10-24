export type Importance = "required" | "preferred";
export type Status = "strong" | "partial" | "missing";

export interface DetailResult {
  mode: "revise" | "add" | "need_more";
  srcId?: string;
  source?: string;
  rewritten?: string;
  why?: string;
  new_status?: Status;
  status_reason?: string;
  question?: string;
}

export interface DetailState {
  open: boolean;
  text: string;
  busy: boolean;
  res: DetailResult | null;
  err: string;
}

export interface Requirement {
  requirement: string;
  importance: Importance;
  status: Status;
  evidence: string;
  tip: string;
  _added?: {
    rewritten: string;
    from: Status;
    to: Status;
    prevTip: string;
    prevEvidence: string;
  };
  _d?: DetailState;
  _term?: string;
}

export interface Bullet {
  original: string;
  rewritten: string;
  why: string;
  needs_confirmation: boolean;
  confirm_note: string;
  mode?: "revise" | "add" | "append";
  anchor?: string;
  from_details?: boolean;
  from_terms?: boolean;
}

export interface KeyTerm {
  term: string;
  supported: boolean;
}

export interface AgentStep {
  text: string;
  ok: boolean | null;
}

export interface AgentState {
  status: "running" | "done" | "fallback" | "failed" | "stopped";
  steps: AgentStep[];
  summary: string;
}

export interface Outreach {
  to: string;
  message: string;
}

export interface FitResult {
  example?: boolean;
  role: string;
  fit_score?: number;
  verdict: string;
  requirements: Requirement[];
  bullets: Bullet[];
  key_terms?: KeyTerm[];
  keywords_missing?: string[];
  outreach?: Outreach;
  _agent?: AgentState;
  _accept?: boolean[];
  _edited?: string;
  _forceClean?: boolean;
  _termRun?: { placed: string[] };
  _termQs?: Requirement[];
  _termErr?: string;
}

export interface DocxFile {
  id: string;
  name: string;
  b64: string;
}

export interface SavedCheck {
  id: string;
  at: string;
  jd: string;
  url: string;
  resume: string;
  docxId: string | null;
  result: FitResult;
}

export interface ResumeBlock {
  type: "blank" | "bullet" | "name" | "contact" | "heading" | "role" | "line";
  text: string;
  changed?: boolean;
  added?: boolean;
}

export interface FitScore {
  score: number;
  lab: string;
  cls: "hi" | "mid" | "lo";
  capped: boolean;
  missingReq: Requirement[];
  earned: number;
  possible: number;
}

export interface ResumeMatch {
  pct: number;
  hit: number;
  total: number;
  unused: string[];
}

export interface MatchPair {
  before: ResumeMatch;
  after: ResumeMatch | null;
}
