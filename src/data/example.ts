import { FitResult } from "../types";

export const EXAMPLE_JD = `Product Manager Intern, AI Platform (Summer 2027)
Harbor Health (example posting)

Harbor Health builds care-navigation tools used by clinicians and patients. Our AI Platform team ships the assistants that answer patient questions and route them to the right care.

What you'll do
- Own a feature on our patient-facing AI assistant from discovery through launch
- Write product requirements and work daily with engineering, design, and clinical teams
- Define success metrics and analyze usage data to decide what to build next
- Run customer interviews with patients and clinicians

What we're looking for
- Current MBA student with prior product, engineering, or technical experience
- Hands-on experience with LLMs, AI agents, or ML-powered products
- Comfort with data analysis (SQL or similar)
- Experience in healthcare or another regulated industry is a plus
- Experience building consumer or clinician-facing products`;

export const SAMPLE_RESUME = `JORDAN RIVERA (sample candidate)

EDUCATION
MBA candidate, Class of 2028
BA Economics, 2021

EXPERIENCE
Ledgerline (small-business fintech) — Product Analyst, 2023–2026
- Built SQL dashboards tracking the onboarding funnel for 400K small-business users, identifying a drop-off that informed a redesign lifting activation 12%
- Partnered with engineering to launch an ML-based transaction categorization feature; wrote acceptance criteria and evaluated accuracy against 2,000 labeled transactions
- Ran 25 customer interviews with small-business owners to define requirements for invoicing reminders, adopted by 30% of active users within one quarter

Northfield Insurance — Business Analyst, 2021–2023
- Automated monthly claims reporting in Python, saving the operations team 20 hours per month
- Documented compliance requirements for a state regulatory audit across 3 claims systems

SKILLS
SQL, Python, Amplitude, Figma, Jira`;

export const EXAMPLE_RESULT: FitResult = {
  example: true,
  role: "Product Manager Intern, AI Platform · Harbor Health",
  fit_score: 74,
  verdict: "Strong analytics and customer-discovery background with hands-on ML product work. Lacks direct healthcare and LLM experience, so lead with how you evaluated the ML launch.",
  requirements: [
    { requirement: "MBA student with prior product or technical experience", importance: "required", status: "strong", evidence: "MBA candidate with three years as a product analyst at a fintech.", tip: "" },
    { requirement: "Hands-on experience with LLMs, AI agents, or ML products", importance: "required", status: "partial", evidence: "Launched an ML categorization feature and measured its accuracy. No LLM or agent work.", tip: "Call the categorization launch AI product work, and be ready to explain how you'd evaluate an LLM the same way." },
    { requirement: "Data analysis with SQL or similar", importance: "required", status: "strong", evidence: "SQL funnel dashboards across 400K users; Python reporting automation.", tip: "" },
    { requirement: "Write requirements with engineering and design", importance: "required", status: "strong", evidence: "Wrote acceptance criteria with engineering for the ML feature.", tip: "" },
    { requirement: "Run customer interviews", importance: "required", status: "strong", evidence: "Ran 25 interviews with small-business owners.", tip: "" },
    { requirement: "Healthcare or regulated-industry experience", importance: "preferred", status: "partial", evidence: "Compliance documentation for a state insurance audit.", tip: "Insurance is regulated. Bring up the audit when they ask about healthcare." },
    { requirement: "Consumer or clinician-facing products", importance: "required", status: "missing", evidence: "", tip: "Prepare a story about a consumer health product you use and one change you'd make to it." }
  ],
  bullets: [
    {
      original: "Partnered with engineering to launch an ML-based transaction categorization feature; wrote acceptance criteria and evaluated accuracy against 2,000 labeled transactions",
      rewritten: "Launched an ML-powered categorization feature with engineering, defining acceptance criteria and validating model accuracy against 2,000 labeled transactions",
      why: "Leads with the AI launch and shows you know how to test a model.",
      needs_confirmation: false,
      confirm_note: ""
    },
    {
      original: "Ran 25 customer interviews with small-business owners to define requirements for invoicing reminders, adopted by 30% of active users within one quarter",
      rewritten: "Led 25 customer interviews to define product requirements for invoicing reminders, a feature adopted by 30% of active users within one quarter",
      why: "Matches 'run customer interviews' and pairs discovery with an adoption result.",
      needs_confirmation: false,
      confirm_note: ""
    },
    {
      original: "Built SQL dashboards tracking the onboarding funnel for 400K small-business users, identifying a drop-off that informed a redesign lifting activation 12%",
      rewritten: "Analyzed onboarding usage data for 400K users in SQL, finding a drop-off that shaped a redesign and lifted activation 12%",
      why: "Mirrors 'analyze usage data to decide what to build next'.",
      needs_confirmation: false,
      confirm_note: ""
    },
    {
      original: "Documented compliance requirements for a state regulatory audit across 3 claims systems",
      rewritten: "Translated state regulatory requirements into documentation across 3 insurance claims systems, preparing the team for a compliance audit",
      why: "Frames the work as regulated-industry experience.",
      needs_confirmation: true,
      confirm_note: "'Preparing the team' describes your role more broadly than the original. Confirm it's accurate."
    }
  ],
  _agent: {
    status: "done",
    summary: "Rewrote four bullets to lead with ML work, customer discovery, and usage analysis, cut the funnel bullet to two lines, and flagged the audit bullet's new framing for you to confirm.",
    steps: [
      { text: "Read your resume: 5 bullets to choose from.", ok: true },
      { text: "Drafting rewrites…", ok: null },
      { text: "Searched your resume for \"LLM\": not found.", ok: null },
      { text: "Checked 4 drafts: 3 passed, 1 need revision.", ok: false },
      { text: "b1: 3 lines (198 characters). Must be 2 lines or fewer; aim for 170 characters.", ok: false },
      { text: "Checked 1 draft: 1 passed.", ok: true },
      { text: "Submitted 4 bullets. All passed the checks.", ok: true }
    ]
  },
  key_terms: [
    { term: "SQL", supported: true },
    { term: "ML", supported: true },
    { term: "product requirements", supported: true },
    { term: "customer interviews", supported: true },
    { term: "usage data", supported: true },
    { term: "engineering", supported: true },
    { term: "launch", supported: true },
    { term: "accuracy", supported: true },
    { term: "activation", supported: true },
    { term: "metrics", supported: true },
    { term: "discovery", supported: true },
    { term: "LLM", supported: false },
    { term: "AI assistant", supported: false },
    { term: "patient experience", supported: false },
    { term: "clinical workflows", supported: false }
  ],
  keywords_missing: ["LLM", "AI assistant", "patient experience", "clinical workflows"],
  outreach: {
    to: "A PM on Harbor Health's AI Platform team",
    message: "Hi [Name],\n\nI'm an MBA candidate who spent three years as a product analyst at a fintech, where I helped launch an ML categorization feature and tested its accuracy against 2,000 labeled transactions.\n\nI'm applying to the AI Platform PM internship and would value 15 minutes to learn how your team decides when the patient assistant's answers are good enough to ship.\n\nThank you,\n[Your name]"
  }
};
