import JSZip from "jszip";
import { jsPDF } from "jspdf";
import mammoth from "mammoth";
import * as pdfjsLib from "pdfjs-dist";
import {
  FitResult,
  FitScore,
  Importance,
  MatchPair,
  Requirement,
  ResumeBlock,
  ResumeMatch,
  Status
} from "../types";

export const MAX_LINES = 2;
export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const XML_NS = "http://www.w3.org/XML/1998/namespace";
export const BULLET_RE = /^\s*(?:[-*•●▪◦–]|•)\s+/;
export const CREDIT: Record<Status, number> = { strong: 1, partial: 0.5, missing: 0 };

export function isPreferred(q: Requirement): boolean {
  return q && q.importance === "preferred";
}

export function fitLabel(s: number): [string, "hi" | "mid" | "lo"] {
  return s >= 90
    ? ["Excellent fit", "hi"]
    : s >= 80
    ? ["Strong fit", "hi"]
    : s >= 70
    ? ["Good fit", "hi"]
    : s >= 55
    ? ["Worth a shot", "mid"]
    : ["Long shot", "lo"];
}

export function computeFit(r: FitResult): FitScore {
  const reqs = Array.isArray(r.requirements) ? r.requirements : [];
  if (!reqs.length) {
    const sc = Math.round(Number(r.fit_score) || 0);
    const [lab, cls] = fitLabel(sc);
    return { score: sc, lab, cls, capped: false, missingReq: [], earned: 0, possible: 0 };
  }
  let earned = 0;
  let possible = 0;
  reqs.forEach((q) => {
    const w = isPreferred(q) ? 1 : 2;
    possible += w;
    earned += w * (CREDIT[q.status] ?? 0.5);
  });
  const score = Math.round((100 * earned) / (possible || 1));
  let [lab, cls] = fitLabel(score);
  const missingReq = reqs.filter((q) => q.status === "missing" && !isPreferred(q));
  const capped = missingReq.length > 0 && score >= 80;
  if (capped) {
    lab = "Good fit";
    cls = "hi";
  }
  return { score, lab, cls, capped, missingReq, earned, possible };
}

export function normTerm(x: string): string {
  return String(x || "")
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasTerm(textNorm: string, term: string): boolean {
  const t = normTerm(term);
  if (!t) return false;
  const forms = new Set([t]);
  if (/s$/.test(t) && t.length > 3) forms.add(t.replace(/e?s$/, ""));
  for (const f of forms) {
    const esc = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp("(^|[^a-z0-9])" + esc + "(s|es|ed|d|ing)?(?=$|[^a-z0-9])").test(textNorm)) {
      return true;
    }
  }
  return false;
}

export function resumeMatch(r: FitResult, text: string): ResumeMatch | null {
  const terms = (Array.isArray(r.key_terms) ? r.key_terms : []).filter(
    (k) => k && k.supported && String(k.term || "").trim()
  );
  if (!terms.length) return null;
  const n = normTerm(text);
  const hit = terms.filter((k) => hasTerm(n, k.term));
  return {
    pct: Math.round((100 * hit.length) / terms.length),
    hit: hit.length,
    total: terms.length,
    unused: terms.filter((k) => !hasTerm(n, k.term)).map((k) => String(k.term))
  };
}

export function matchPair(r: FitResult, currentResume: string): MatchPair | null {
  const before = resumeMatch(r, currentResume);
  if (!before) return null;
  const bl = Array.isArray(r.bullets) ? r.bullets : [];
  const running = r._agent && r._agent.status === "running";
  const after = bl.length && !running ? resumeMatch(r, tailoredText(r, currentResume)) : null;
  return { before, after };
}

export function tidy(t: string): string {
  return t
    .replace(/\r/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/[●•▪◦]\s*/g, "- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function scrubContact(t: string): { text: string; removed: number } {
  let n = 0;
  const out = t
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, () => {
      n++;
      return "";
    })
    .replace(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, () => {
      n++;
      return "";
    })
    .replace(/([ \t]*\|[ \t]*){2,}/g, " | ")
    .replace(/\|\s*$/gm, "")
    .replace(/^\s*\|\s*/gm, "");
  return { text: out, removed: n };
}

export async function readPdf(buf: ArrayBuffer): Promise<string> {
  const lib: any = pdfjsLib;
  if (!lib.GlobalWorkerOptions.workerSrc) {
    lib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  const pdf = await lib.getDocument({ data: buf, isEvalSupported: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= Math.min(pdf.numPages, 8); i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let out = "";
    for (const it of tc.items) {
      if (!("str" in it)) continue;
      out += it.str + (it.hasEOL ? "\n" : "");
    }
    pages.push(out);
  }
  return pages.join("\n");
}

function ownPara(n: Node | null): Node | null {
  while (n && !(n.nodeType === 1 && (n as Element).namespaceURI === W_NS && (n as Element).localName === "p")) {
    n = n.parentNode;
  }
  return n;
}

function wRuns(p: Element): Element[] {
  return [...p.getElementsByTagNameNS(W_NS, "r")].filter((r) => ownPara(r.parentNode) === p);
}

function runText(r: Element): string {
  let s = "";
  for (const n of Array.from(r.childNodes)) {
    const el = n as Element;
    if (el.namespaceURI !== W_NS) continue;
    if (el.localName === "t") s += el.textContent;
    else if (el.localName === "tab") s += "\t";
    else if (el.localName === "br" || el.localName === "cr") s += " ";
    else if (el.localName === "noBreakHyphen") s += "-";
  }
  return s;
}

function paraText(p: Element): string {
  return wRuns(p).map(runText).join("");
}

export function docxXmlToText(docXml: string, stylesXml?: string): string {
  const P = (x: string) => new DOMParser().parseFromString(x, "application/xml");
  const doc = P(docXml);
  if (doc.getElementsByTagName("parsererror").length) throw new Error("docx_parse");
  const listStyles = new Set<string>();
  if (stylesXml) {
    const st = P(stylesXml);
    [...st.getElementsByTagNameNS(W_NS, "style")].forEach((x) => {
      const id = x.getAttributeNS(W_NS, "styleId") || x.getAttribute("w:styleId") || "";
      const nm = x.getElementsByTagNameNS(W_NS, "name")[0];
      const name = nm ? nm.getAttributeNS(W_NS, "val") || nm.getAttribute("w:val") || "" : "";
      if (
        x.getElementsByTagNameNS(W_NS, "numPr").length ||
        /list ?(bullet|number|paragraph)/i.test(name) ||
        /^List(Bullet|Number|Paragraph)/i.test(id)
      ) {
        listStyles.add(id);
      }
    });
  }
  const out: string[] = [];
  [...doc.getElementsByTagNameNS(W_NS, "p")].forEach((p) => {
    if (ownPara(p.parentNode)) return;
    const text = paraText(p).replace(/\s+/g, " ").trim();
    if (!text) return;
    const pPr = [...p.childNodes].find((n) => (n as Element).namespaceURI === W_NS && (n as Element).localName === "pPr") as Element | undefined;
    let list = false;
    if (pPr) {
      if (pPr.getElementsByTagNameNS(W_NS, "numPr").length) list = true;
      const ps = pPr.getElementsByTagNameNS(W_NS, "pStyle")[0];
      if (ps && listStyles.has(ps.getAttributeNS(W_NS, "val") || ps.getAttribute("w:val") || "")) {
        list = true;
      }
    }
    out.push(list && !BULLET_RE.test(text) ? "- " + text : text);
  });
  return out.join("\n");
}

export async function readDocx(buf: ArrayBuffer): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(buf);
    const d = zip.file("word/document.xml");
    if (!d) throw new Error("docx_parse");
    const st = zip.file("word/styles.xml");
    return docxXmlToText(await d.async("string"), st ? await st.async("string") : "");
  } catch {
    const r = await mammoth.extractRawText({ arrayBuffer: buf });
    return r.value;
  }
}

export function parseResume(text: string): ResumeBlock[] {
  const raw = String(text || "")
    .replace(/\r/g, "")
    .split("\n");
  const out: ResumeBlock[] = [];
  let seenName = false;
  let seenHeading = false;

  for (const line0 of raw) {
    const line = line0.trim();
    if (!line) {
      out.push({ type: "blank", text: "" });
      continue;
    }
    const prev = [...out].reverse().find((b) => b.type !== "blank");
    const lastWasBlank = out.length && out[out.length - 1].type === "blank";
    if (BULLET_RE.test(line)) {
      out.push({ type: "bullet", text: line.replace(BULLET_RE, "") });
      continue;
    }
    if (prev && prev.type === "bullet" && !lastWasBlank && /^[a-z0-9($&%,;]/.test(line)) {
      prev.text += " " + line;
      continue;
    }
    if (!seenName) {
      out.push({ type: "name", text: line });
      seenName = true;
      continue;
    }
    const letters = line.replace(/[^A-Za-z]/g, "");
    if (letters.length >= 3 && line === line.toUpperCase() && line.length <= 45) {
      out.push({ type: "heading", text: line });
      seenHeading = true;
      continue;
    }
    if (!seenHeading) {
      out.push({ type: "contact", text: line });
      continue;
    }
    const capsLead = /^[A-Z][A-Z&.'-]{2,}(\s|,|$)/.test(line);
    out.push({ type: /\b(19|20)\d{2}\b/.test(line) || capsLead ? "role" : "line", text: line });
  }

  while (out.length && out[out.length - 1].type === "blank") out.pop();
  if (!out.some((b) => b.type === "bullet")) inferBullets(out);
  return out;
}

export function inferBullets(blocks: ResumeBlock[]): void {
  const DATE_RANGE = /\b(19|20)\d{2}\s*[-–—to]+\s*((19|20)\d{2}|present|current|now)\b/i;
  let inSection = false;
  blocks.forEach((b) => {
    if (b.type === "heading") {
      inSection = !/^(skills|additional|interests|certifications|tools|languages)/i.test(b.text.trim());
      return;
    }
    if (!inSection || !(b.type === "line" || b.type === "role")) return;
    const t = b.text.trim();
    if (t.length < 70 || DATE_RANGE.test(t) || /^[A-Za-z &/]{2,28}:/.test(t) || /[:;]$/.test(t)) return;
    if (!/[a-z]{3,}/.test(t) || !/\s[a-z]+\s[a-z]+\s/.test(t)) return;
    b.type = "bullet";
  });
}

export function words(s: string): Set<string> {
  return new Set(
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9%$.+]+/g, " ")
      .split(" ")
      .filter((w) => w.length > 1)
  );
}

export function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  A.forEach((w) => {
    if (B.has(w)) n++;
  });
  return n / (A.size + B.size - n);
}

export function matchBullets(blocks: ResumeBlock[], suggestions: Array<{ original: string }>): number[] {
  const taken = new Set<number>();
  return suggestions.map((s) => {
    let best = -1;
    let score = 0;
    blocks.forEach((b, i) => {
      if (b.type !== "bullet" || taken.has(i)) return;
      const sc = similarity(b.text, s.original);
      if (sc > score) {
        score = sc;
        best = i;
      }
    });
    if (score >= 0.45) {
      taken.add(best);
      return best;
    }
    return -1;
  });
}

export function shownText(b: { mode?: string; original?: string; rewritten: string }): string {
  return b.mode === "append" ? String(b.original || "").replace(/[\s,;]+$/, "") + b.rewritten : b.rewritten;
}

export function lineIndex(blocks: ResumeBlock[], text: string): number {
  let best = -1;
  let score = 0;
  blocks.forEach((b, i) => {
    if (b.type === "blank" || b.type === "heading") return;
    const sc = similarity(b.text, text);
    if (sc > score) {
      score = sc;
      best = i;
    }
  });
  return score >= 0.6 ? best : -1;
}

export function anchorIndex(blocks: ResumeBlock[], text: string): number {
  let best = -1;
  let score = 0;
  blocks.forEach((b, i) => {
    if (b.type !== "bullet") return;
    const sc = similarity(b.text, text);
    if (sc > score) {
      score = sc;
      best = i;
    }
  });
  return score >= 0.45 ? best : -1;
}

export function syncAccept(r: FitResult): void {
  const bullets = Array.isArray(r.bullets) ? r.bullets : [];
  if (!Array.isArray(r._accept)) r._accept = [];
  while (r._accept.length < bullets.length) {
    const b = bullets[r._accept.length];
    r._accept.push(!b.needs_confirmation);
  }
  if (r._accept.length > bullets.length) r._accept.length = bullets.length;
}

export function tailoredBlocks(
  r: FitResult,
  currentResume: string
): { blocks: ResumeBlock[]; map: number[] } {
  const bullets = Array.isArray(r.bullets) ? r.bullets : [];
  syncAccept(r);
  const blocks = parseResume(currentResume);
  const map = matchBullets(
    blocks,
    bullets.map((b) => ({ original: b.mode === "add" || b.mode === "append" ? "" : b.original }))
  );
  bullets.forEach((b, k) => {
    if (b.mode === "add") map[k] = anchorIndex(blocks, b.anchor || "");
    if (b.mode === "append") map[k] = lineIndex(blocks, b.original || "");
  });
  map.forEach((i, k) => {
    if (i < 0 || !r._accept?.[k]) return;
    const b = bullets[k];
    if (b.mode === "append") {
      blocks[i] = { ...blocks[i], text: blocks[i].text.replace(/[\s,;]+$/, "") + b.rewritten, changed: true };
    } else if (b.mode !== "add") {
      blocks[i] = { ...blocks[i], text: b.rewritten, changed: true };
    }
  });
  const adds = bullets
    .map((b, k) => ({ b, k, i: map[k] }))
    .filter((x) => x.b.mode === "add" && x.i >= 0 && r._accept?.[x.k])
    .sort((a, b) => b.i - a.i || b.k - a.k);

  adds.forEach((x) => blocks.splice(x.i + 1, 0, { type: "bullet", text: x.b.rewritten, changed: true, added: true }));
  return { blocks, map };
}

export function blocksToText(blocks: ResumeBlock[]): string {
  return blocks.map((b) => (b.type === "bullet" ? "- " + b.text : b.text)).join("\n");
}

export function tailoredText(r: FitResult, currentResume: string): string {
  if (typeof r._edited === "string") return r._edited;
  return blocksToText(tailoredBlocks(r, currentResume).blocks);
}

export function resumeFilename(r: FitResult, blocks: ResumeBlock[], ext: string): string {
  const name = (blocks.find((b) => b.type === "name")?.text || "Resume").replace(/\(.*?\)/g, "").trim();
  const co = String(r.role || "").split("·").pop()?.trim() || "";
  const base = [
    name.replace(/\b\w+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
    co && co !== r.role ? co : "",
    "Resume"
  ]
    .filter(Boolean)
    .join(" - ");
  return base.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").slice(0, 120) + "." + ext;
}

let measureCtx: CanvasRenderingContext2D | null = null;
export function bulletLines(text: string): number {
  text = String(text || "").trim();
  if (!text) return 0;
  if (!measureCtx) {
    try {
      measureCtx = document.createElement("canvas").getContext("2d");
    } catch {}
  }
  if (!measureCtx) return Math.ceil(text.length / 95);
  measureCtx.font = "10px Helvetica, Arial, sans-serif";
  const max = (490 / 10) * 10;
  let lines = 1;
  let cur = 0;
  const space = measureCtx.measureText(" ").width;
  for (const w of text.split(/\s+/)) {
    const ww = measureCtx.measureText(w).width;
    if (cur === 0) cur = ww;
    else if (cur + space + ww <= max) cur += space + ww;
    else {
      lines++;
      cur = ww;
    }
  }
  return lines;
}

export function extractNums(s: string): Set<string> {
  return new Set(
    (String(s || "").match(/\$?\d[\d,]*(?:\.\d+)?\s*(?:%|[kmb](?![a-z])|x(?![a-z]))?/gi) || [])
      .map((n) => n.toLowerCase().replace(/[\s,$]/g, ""))
      .filter((n) => n && !/^(19|20)\d{2}$/.test(n))
  );
}

export function resumeBulletList(text: string): Array<{ id: string; text: string }> {
  return parseResume(text)
    .filter((b) => b.type === "bullet")
    .map((b, i) => ({ id: "b" + (i + 1), text: b.text }));
}

export function b64ToBuf(b64: string): ArrayBuffer {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}

export function bufToB64(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + 0x8000)));
  }
  return btoa(s);
}

const LEAD_RE = /^[\s ●•▪◦·\-–—*►✓➢§o]*/;

function appendParaText(p: Element, suffix: string): boolean {
  const runs = wRuns(p).filter((r) => runText(r).trim());
  if (!runs.length) return false;
  const last = runs[runs.length - 1];
  const doc = p.ownerDocument;
  [...last.getElementsByTagNameNS(W_NS, "t")].reverse().find((t) => {
    if (/[\s,;]+$/.test(t.textContent || "")) {
      t.textContent = (t.textContent || "").replace(/[\s,;]+$/, "");
    }
    return true;
  });
  const nr = doc.createElementNS(W_NS, "w:r");
  const rPr = [...last.childNodes].find((n) => (n as Element).namespaceURI === W_NS && (n as Element).localName === "rPr");
  if (rPr) nr.appendChild(rPr.cloneNode(true));
  const t = doc.createElementNS(W_NS, "w:t");
  t.setAttributeNS(XML_NS, "xml:space", "preserve");
  t.textContent = suffix;
  nr.appendChild(t);
  last.parentNode?.insertBefore(nr, last.nextSibling);
  return true;
}

function replaceParaText(p: Element, text: string): boolean {
  const runs = wRuns(p);
  const k = runs.findIndex((r) => /[A-Za-z0-9$(]/.test(runText(r)));
  if (k < 0) return false;
  const first = runs[k];
  const doc = p.ownerDocument;
  const firstText = runText(first);
  const lead = (firstText.match(LEAD_RE) || [""])[0].replace(/[A-Za-z0-9]/g, "");
  const nr = doc.createElementNS(W_NS, "w:r");
  const rPr = [...first.childNodes].find((n) => (n as Element).namespaceURI === W_NS && (n as Element).localName === "rPr");
  if (rPr) nr.appendChild(rPr.cloneNode(true));
  const t = doc.createElementNS(W_NS, "w:t");
  t.setAttributeNS(XML_NS, "xml:space", "preserve");
  t.textContent = lead + text;
  nr.appendChild(t);
  first.parentNode?.insertBefore(nr, first);
  for (let i = k; i < runs.length; i++) {
    runs[i].parentNode?.removeChild(runs[i]);
  }
  [...p.getElementsByTagNameNS(W_NS, "proofErr")].forEach((n) => n.parentNode?.removeChild(n));
  [...p.childNodes].forEach((n) => {
    const el = n as Element;
    if (
      el.nodeType === 1 &&
      el.namespaceURI === W_NS &&
      ["hyperlink", "smartTag", "ins", "customXml", "sdt"].includes(el.localName) &&
      !el.getElementsByTagNameNS(W_NS, "r").length
    ) {
      p.removeChild(el);
    }
  });
  return true;
}

export function editDocumentXml(
  xml: string,
  reps: Array<{ original?: string; rewritten: string; mode?: string; anchor?: string }>,
  opts: { dryRun?: boolean } = {}
): { xml: string; found: boolean[] } {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("docx_parse");
  const paras = [...doc.getElementsByTagNameNS(W_NS, "p")];
  const texts = paras.map(paraText);
  const used = new Set<number>();
  const bestFor = (text: string, skipUsed: boolean) => {
    let best = -1;
    let score = 0;
    texts.forEach((t, i) => {
      if ((skipUsed && used.has(i)) || t.trim().length < 20) return;
      const s = similarity(t, text);
      if (s > score) {
        score = s;
        best = i;
      }
    });
    return score >= 0.5 ? best : -1;
  };
  const found: boolean[] = reps.map(() => false);
  const lastAfter = new Map<number, Element>();

  reps.forEach((rep, k) => {
    if (rep.mode === "add" || rep.mode === "append") return;
    const i = bestFor(rep.original || "", true);
    if (i < 0) return;
    used.add(i);
    found[k] = opts.dryRun ? true : replaceParaText(paras[i], rep.rewritten);
  });

  reps.forEach((rep, k) => {
    if (rep.mode !== "append") return;
    const i = bestFor(rep.original || "", false);
    if (i < 0) return;
    found[k] = opts.dryRun ? true : appendParaText(paras[i], rep.rewritten);
  });

  reps.forEach((rep, k) => {
    if (rep.mode !== "add") return;
    const i = bestFor(rep.anchor || "", false);
    if (i < 0) return;
    if (opts.dryRun) {
      found[k] = true;
      return;
    }
    const after = lastAfter.get(i) || paras[i];
    const clone = paras[i].cloneNode(true) as Element;
    if (!replaceParaText(clone, rep.rewritten)) return;
    after.parentNode?.insertBefore(clone, after.nextSibling);
    lastAfter.set(i, clone);
    found[k] = true;
  });

  return { xml: opts.dryRun ? xml : new XMLSerializer().serializeToString(doc), found };
}

export async function editDocx(
  b64: string,
  reps: Array<{ original?: string; rewritten: string; mode?: string; anchor?: string }>,
  opts: { dryRun?: boolean } = {}
): Promise<{ blob?: Blob; found: boolean[] }> {
  const zip = await JSZip.loadAsync(b64ToBuf(b64));
  const f = zip.file("word/document.xml");
  if (!f) throw new Error("docx_parse");
  const { xml, found } = editDocumentXml(await f.async("string"), reps, opts);
  if (opts.dryRun) return { found };
  zip.file("word/document.xml", xml);
  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });
  return { blob, found };
}

function xesc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

export function docxParts(blocks: ResumeBlock[]): Record<string, string> {
  const font = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>';
  const run = (t: string, { b = false, sz = 21, caps = false } = {}) =>
    `<w:r><w:rPr>${font}${b ? "<w:b/>" : ""}${caps ? "<w:caps/>" : ""}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${xesc(t)}</w:t></w:r>`;
  const p = (ppr: string, runs: string) => `<w:p><w:pPr>${ppr}</w:pPr>${runs}</w:p>`;
  const body: string[] = [];

  for (const b of blocks) {
    if (b.type === "blank") continue;
    if (b.type === "name") {
      body.push(p('<w:jc w:val="center"/><w:spacing w:after="40"/>', run(b.text, { b: true, sz: 32 })));
    } else if (b.type === "contact") {
      body.push(p('<w:jc w:val="center"/><w:spacing w:after="40"/>', run(b.text, { sz: 19 })));
    } else if (b.type === "heading") {
      body.push(
        p(
          '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="404040"/></w:pBdr><w:spacing w:before="200" w:after="80"/>',
          run(b.text, { b: true, sz: 22 })
        )
      );
    } else if (b.type === "role") {
      body.push(p('<w:spacing w:before="100" w:after="30"/>', run(b.text, { b: true })));
    } else if (b.type === "bullet") {
      body.push(
        p(
          '<w:tabs><w:tab w:val="left" w:pos="360"/></w:tabs><w:ind w:left="360" w:hanging="240"/><w:spacing w:after="30"/>',
          run("•\t" + b.text)
        )
      );
    } else {
      body.push(p('<w:spacing w:after="30"/>', run(b.text)));
    }
  }

  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="864" w:right="1008" w:bottom="864" w:left="1008" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": doc
  };
}

export async function buildDocx(blocks: ResumeBlock[]): Promise<Blob> {
  const zip = new JSZip();
  const parts = docxParts(blocks);
  Object.entries(parts).forEach(([k, v]) => zip.file(k, v));
  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });
}

function pdfSafe(s: string): string {
  return String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[●▪◦]/g, "•")
    .replace(/[^\x20-\x7E -ÿ–—•…€]/g, "");
}

export async function buildPdf(blocks: ResumeBlock[]): Promise<Blob> {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const L = 54;
  const R = 612 - 54;
  const W = R - L;
  const BOTTOM = 792 - 50;
  let y = 56;

  const ensure = (h: number) => {
    if (y + h > BOTTOM) {
      doc.addPage();
      y = 56;
    }
  };

  const write = (
    text: string,
    { size = 10, bold = false, align = "left", indent = 0, after = 3, lead = 1.32 } = {}
  ) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(pdfSafe(text), W - indent);
    lines.forEach((ln: string) => {
      ensure(size * lead);
      const x = align === "center" ? (L + R) / 2 : L + indent;
      doc.text(ln, x, y, { align: align === "center" ? "center" : "left" });
      y += size * lead;
    });
    y += after;
  };

  for (const b of blocks) {
    if (b.type === "blank") continue;
    if (b.type === "name") {
      write(b.text, { size: 17, bold: true, align: "center", after: 2 });
    } else if (b.type === "contact") {
      write(b.text, { size: 9.5, align: "center", after: 1 });
    } else if (b.type === "heading") {
      y += 8;
      ensure(30);
      write(b.text, { size: 11, bold: true, after: 0 });
      doc.setLineWidth(0.6);
      doc.setDrawColor(64);
      doc.line(L, y - 8, R, y - 8);
      y += 4;
    } else if (b.type === "role") {
      y += 3;
      write(b.text, { size: 10.5, bold: true, after: 2 });
    } else if (b.type === "bullet") {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      const lines = doc.splitTextToSize(pdfSafe(b.text), W - 14);
      ensure(lines.length * 13.2);
      doc.text("•", L + 3, y);
      lines.forEach((ln: string) => {
        ensure(13.2);
        doc.text(ln, L + 14, y);
        y += 13.2;
      });
      y += 2.5;
    } else {
      write(b.text, { size: 10 });
    }
  }
  return doc.output("blob");
}

export function saveBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
