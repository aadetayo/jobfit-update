# JobFit

**Know your fit before you hit apply.** Upload your resume and paste a job posting. JobFit scores your fit requirement by requirement, shows which gaps to address, uses an AI agent to rewrite your bullets in the posting's language, and lets you download a tailored resume in your own Word format.

It never invents experience: every rewrite is checked in code against your original resume before it's shown.

## Architecture

```
React Frontend (src/App.tsx)                 Server (server.ts)              Gemini API
  resume parsing, scoring, Word editing  ->  POST /api/generate  ->  generateContent
  agent loop: runs the checking tools    <-  model reply          <-  (key stays here)
```

- **React SPA + TypeScript**: Modular components for Resume Upload, Job Posting, Recruiter Scoreboard, Gap Addressing, Multi-step Bullet Agent, Tailored Resume with Word/PDF export, and Outreach Generator.
- **Fit score** is calculated in code from the AI's per-requirement judgments: strong = full credit, partial = half, missing = none, required items count double. A missing required item caps the label at "Good fit".
- **Resume match** measures how many of the posting's key terms your resume uses, counting only terms your experience supports.
- **The bullet agent** drafts rewrites, then calls three tools in the browser (`search_resume`, `check_bullets`, `submit_bullets`). The tools reject invented numbers, unsupported terms, and bullets over two lines. The agent revises until everything passes.
- **Word files** are edited in place: only accepted bullets change, preserving fonts, spacing, and layout. Clean layouts also support direct DOCX and PDF export.
- **Privacy:** your resume is saved only in your browser. Contact information (emails, phone numbers) is scrubbed before sending text for analysis.

## Development

```bash
npm install
npm run dev
```

Build for production:
```bash
npm run build
npm start
```
