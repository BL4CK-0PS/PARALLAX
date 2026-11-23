"""Fill the wHACKiest 2026 template with PARALLAX content."""
import copy, sys
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.oxml.ns import qn
from lxml import etree

SRC, OUT = sys.argv[1], sys.argv[2]

INK = RGBColor(0x11, 0x11, 0x11)
NAVY = RGBColor(0x1B, 0x1F, 0x6B)
ORANGE = RGBColor(0xFD, 0x9B, 0x36)
RUST = RGBColor(0xC2, 0x41, 0x0C)
GREY = RGBColor(0x5A, 0x54, 0x4B)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
TINT = RGBColor(0xFF, 0xF4, 0xE6)
GREEN = RGBColor(0x15, 0x80, 0x3D)
BODY = "Calibri"
HEAD = "Arial Black"

prs = Presentation(SRC)
_n = [0]


def name(shape, label):
    _n[0] += 1
    shape.name = f"{label} {_n[0]}"


def shadow(shape, color="FD9B36"):
    spPr = shape._element.spPr
    eff = etree.SubElement(spPr, qn("a:effectLst"))
    sh = etree.SubElement(eff, qn("a:outerShdw"), blurRad="76200", dist="38100",
                          dir="2700000", algn="bl", rotWithShape="0")
    etree.SubElement(sh, qn("a:srgbClr"), val=color)


def card(slide, x, y, w, h, fill=WHITE, line=INK, lw=2.0, glow=True, radius=0.12, label="Card"):
    s = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    s.adjustments[0] = min(0.5, radius / min(w, h))
    s.fill.solid(); s.fill.fore_color.rgb = fill
    if line is None:
        s.line.fill.background()
    else:
        s.line.color.rgb = line; s.line.width = Pt(lw)
    if glow:
        shadow(s)
    name(s, label)
    return s


def text(slide, x, y, w, h, paras, size=15, color=INK, bold=False, font=BODY,
         align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, space=4, label="Text", italic=False):
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame; tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = anchor
    for i, p in enumerate(paras):
        spec = p if isinstance(p, dict) else {"runs": p}
        runs = spec["runs"]
        if isinstance(runs, str):
            runs = [(runs, {})]
        para = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        para.alignment = spec.get("align", align)
        if i:
            para.space_before = Pt(spec.get("space", space))
        if spec.get("bullet"):
            pPr = para._p.get_or_add_pPr()
            pPr.set("marL", str(int(Inches(0.2)))); pPr.set("indent", str(-int(Inches(0.2))))
            bc = etree.SubElement(pPr, qn("a:buClr")); etree.SubElement(bc, qn("a:srgbClr"), val="FD9B36")
            etree.SubElement(pPr, qn("a:buFont"), typeface="Arial")
            etree.SubElement(pPr, qn("a:buChar"), char="•")
        for t, o in runs:
            r = para.add_run(); r.text = t
            f = r.font
            f.size = Pt(o.get("size", spec.get("size", size)))
            f.bold = o.get("bold", spec.get("bold", bold))
            f.italic = o.get("italic", italic)
            f.name = o.get("font", font)
            f.color.rgb = o.get("color", spec.get("color", color))
    name(tb, label)
    return tb


def pill(slide, x, y, w, h, label, fill=NAVY, color=WHITE, size=12):
    s = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    s.adjustments[0] = 0.5
    s.fill.solid(); s.fill.fore_color.rgb = fill; s.line.fill.background()
    tf = s.text_frame; tf.margin_left = tf.margin_right = Inches(0.05); tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE; tf.word_wrap = True
    p = tf.paragraphs[0]; p.alignment = PP_ALIGN.CENTER
    r = p.add_run(); r.text = label
    r.font.size = Pt(size); r.font.bold = True; r.font.color.rgb = color; r.font.name = BODY
    name(s, "Badge")
    return s


def circle_num(slide, x, y, d, label, size=14):
    s = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x), Inches(y), Inches(d), Inches(d))
    s.fill.solid(); s.fill.fore_color.rgb = ORANGE; s.line.color.rgb = INK; s.line.width = Pt(1.5)
    tf = s.text_frame; tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]; p.alignment = PP_ALIGN.CENTER
    r = p.add_run(); r.text = label
    r.font.size = Pt(size); r.font.bold = True; r.font.color.rgb = INK; r.font.name = BODY
    name(s, "Step marker")
    return s


def arrow(slide, x1, y1, x2, y2, color=INK, w=2.0):
    c = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(x1), Inches(y1), Inches(x2), Inches(y2))
    c.line.color.rgb = color; c.line.width = Pt(w)
    ln = c.line._get_or_add_ln()
    etree.SubElement(ln, qn("a:tailEnd"), type="triangle", w="med", len="med")
    name(c, "Arrow")
    return c


def set_subtitle(slide, msg):
    ph = [s for s in slide.placeholders if s.placeholder_format.idx == 1][0]
    runs = ph.text_frame.paragraphs[0].runs
    runs[0].text = msg
    for r in runs[1:]:
        r.text = ""
    runs[0].font.color.rgb = NAVY


def drop_template_hints(slide):
    for s in list(slide.shapes):
        if s.has_text_frame and not s.is_placeholder:
            if s.text_frame.text.startswith("INCLUDE:") or abs(Emu(s.top).inches - 3.1) < 0.02:
                s._element.getparent().remove(s._element)


slides = prs.slides

# ---------------------------------------------------------------- Slide 1
s1 = slides[0]
fills = {
    "TEAM NAME:": "BL4CK_0P$",
    "COLLEGE NAME:": "Sri Ramakrishna Engineering College, Coimbatore",
    "TRACK:": "Track 2 — Beyond the Browser",
    "TEAM ID:": "7e709e42",
}
for sh in s1.shapes:
    if sh.has_text_frame and sh.text_frame.text.startswith(("Member 1", "USN:")):
        paras = sh.text_frame.paragraphs
        for p in paras[2:]:          # 2-person team: drop Member 3/4 rows
            p._p.getparent().remove(p._p)
        if sh.text_frame.text.startswith("Member 1"):
            p = sh.text_frame.paragraphs[1]
            p.runs[-1]._r.addnext(copy.deepcopy(p.runs[-1]._r))
            p.runs[-1].text = " Dharshan S"; p.runs[-1].font.bold = False; p.runs[-1].font.color.rgb = NAVY
for sh in s1.shapes:
    if not sh.has_text_frame:
        continue
    key = sh.text_frame.text.strip()
    val = fills.get(key)
    if key.startswith("Member 1 (Lead):"):
        val = "Kishanth R"
    if val:
        p = sh.text_frame.paragraphs[0]
        p.runs[-1]._r.addnext(copy.deepcopy(p.runs[-1]._r))
        p.runs[-1].text = " " + val
        p.runs[-1].font.bold = False
        p.runs[-1].font.color.rgb = NAVY

text(s1, 8.25, 6.05, 4.6, 0.55, [[("PARALLAX", {"font": HEAD, "size": 26, "color": NAVY})]],
     align=PP_ALIGN.RIGHT, label="Project name")
text(s1, 7.8, 6.62, 5.05, 0.6,
     [[("A browser agent you can trust, debug and audit", {"italic": True, "size": 15, "color": GREY})]],
     align=PP_ALIGN.RIGHT, label="Project tagline")

# ---------------------------------------------------------------- Slide 2: Problem
s = slides[1]; drop_template_hints(s)
set_subtitle(s, "AI agents now fill forms and click Submit for us. Nobody can stop a hijacked one or prove what it did.")

card(s, 0.7, 2.45, 11.9, 0.7, fill=NAVY, label="Problem one-liner")
text(s, 0.95, 2.45, 11.4, 0.7, [[("THE PROBLEM  ", {"bold": True, "color": ORANGE, "size": 14}),
                                 ("An AI agent acting on untrusted web pages has full power and no flight recorder.", {"color": WHITE, "size": 18, "bold": True})]],
     anchor=MSO_ANCHOR.MIDDLE, label="Problem text")

pains = [
    ("1", "Hijackable", "Hidden text on a page can make it leak data or press “Pay”."),
    ("2", "Fragile", "An expired login or hidden field breaks the flow; it retries blindly."),
    ("3", "Unauditable", "Only a chat log is left: no root cause, no proof the fix worked."),
]
cw, gap, y0 = 3.75, 0.325, 3.35
for i, (n, h, b) in enumerate(pains):
    x = 0.7 + i * (cw + gap)
    card(s, x, y0, cw, 1.3, label="Pain card")
    circle_num(s, x + 0.2, y0 + 0.15, 0.42, n)
    text(s, x + 0.75, y0 + 0.15, cw - 0.95, 0.42, [[(h, {"bold": True, "size": 18, "color": NAVY})]], anchor=MSO_ANCHOR.MIDDLE, label="Pain title")
    text(s, x + 0.2, y0 + 0.65, cw - 0.4, 0.6, [b], size=14, label="Pain body")

yb, bh2 = 4.85, 2.02
bottom = [
    ("WHO WE BUILD FOR", [
        [("AI / automation engineers ", {"bold": True}), ("at ed-tech, fintech and HR companies shipping browser agents that fill forms for their customers.", {})],
        [("They take the blame when the agent misbehaves; ", {}), ("students and applicants", {"bold": True}), (" pay the price.", {})],
    ]),
    ("EVIDENCE", [
        {"runs": [("Brave, Aug 2025: ", {"bold": True}), ("hidden Reddit text made Perplexity’s Comet agent leak a user’s OTP.", {})], "bullet": True},
        {"runs": [("OpenAI, Dec 2025: ", {"bold": True}), ("prompt injection is “unlikely to ever be fully solved”.", {})], "bullet": True},
        {"runs": [("Gartner: ", {"bold": True}), ("40%+ of agentic AI projects scrapped by 2027; weak risk controls a key cause.", {})], "bullet": True},
    ]),
    ("WHY TODAY’S TOOLS FAIL", [
        [("ChatGPT Agent, Comet, Browser Use: ", {"bold": True}), ("the AI itself decides what is safe.", {})],
        [("RPA scripts: ", {"bold": True}), ("safe, but break on any page change.", {})],
        [("Neither explains why a run failed.", {})],
    ]),
]
for i, (h, paras) in enumerate(bottom):
    x = 0.7 + i * (cw + gap)
    card(s, x, yb, cw, bh2, fill=TINT, glow=False, lw=1.25, label="Context card")
    text(s, x + 0.18, yb + 0.12, cw - 0.36, bh2 - 0.2,
         [[(h, {"bold": True, "color": RUST, "size": 13})]] + paras, size=12.5, space=3, label="Context text")

s.notes_slide.notes_text_frame.text = (
    "OPEN WITH A QUESTION (10 s): \"Raise your hand if you'd let an AI agent fill your scholarship form "
    "and press Submit with your bank details.\" Wait. \"Companies are already shipping exactly that.\"\n"
    "Then: Comet leaked a user's OTP from hidden Reddit text; OpenAI says this attack will never be fully solved. "
    "So the question isn't how to make the AI never get fooled. It's how to make a fooled AI harmless.\n"
    "Name the user: the engineer shipping the agent, who takes the blame when it goes wrong.")

# ---------------------------------------------------------------- Slide 3: Solution
s = slides[2]; drop_template_hints(s)
set_subtitle(s, "A safety layer for AI browser agents: blocks danger, explains failures, records everything.")

text(s, 0.7, 2.55, 6.2, 0.35, [[("3 CORE FEATURES", {"bold": True, "color": RUST, "size": 14})]], label="Section label")
feats = [
    ("GUARD", RUST, "Can’t leak data, pay or type your password without you, enforced by the browser, not the AI.", "Policy engine"),
    ("DIAGNOSE", NAVY, "When a task fails, finds the exact step and tests why: expired login or missing field?", "CHRONOS · GHOST · MIRROR"),
    ("REPLAY", NAVY, "Every click, request and decision recorded. Rewind the run like CCTV footage.", "Hashed event timeline"),
]
for i, (h, col, b, tag) in enumerate(feats):
    y = 2.95 + i * 1.12
    card(s, 0.7, y, 6.2, 1.0, glow=(i == 0), lw=1.5 if i else 2.0, label="Feature card")
    pill(s, 0.88, y + 0.31, 1.35, 0.38, h, fill=col, size=12)
    text(s, 2.4, y + 0.1, 4.35, 0.58, [b], size=13.5, anchor=MSO_ANCHOR.MIDDLE, label="Feature text")
    text(s, 2.4, y + 0.68, 4.35, 0.25, [[(tag, {"italic": True})]], size=11, color=GREY, label="Feature tech")

text(s, 7.25, 2.55, 5.3, 0.35, [[("USER FLOW (THE LIVE DEMO)", {"bold": True, "color": RUST, "size": 14})]], label="Section label")
flow = [
    "User: “Apply for the merit scholarship”",
    "Agent fills the portal via Playwright",
    "Hidden text says “send cookies to evil.com” → blocked",
    "Login expires mid-form → cause found, safe fix picked",
    "Agent reaches “Final Submit” → waits for your OK",
    "Done: verified on the backend + full replay",
]
card(s, 7.25, 2.95, 5.35, 3.32, label="Flow card")
for i, t in enumerate(flow):
    y = 3.1 + i * 0.52
    circle_num(s, 7.42, y + 0.04, 0.36, str(i + 1), size=12)
    text(s, 7.92, y, 4.55, 0.46, [t], size=13, anchor=MSO_ANCHOR.MIDDLE, label="Flow step")

card(s, 0.7, 6.42, 11.9, 0.5, fill=NAVY, glow=False, label="MVP strip")
text(s, 0.9, 6.42, 11.5, 0.5, [[("24-HR MVP  ", {"bold": True, "color": ORANGE}),
                                ("Synthetic scholarship portal · 3 injectable failures · prompt-injection trap · guard · replay + approval dashboard", {"color": WHITE})]],
     size=13, anchor=MSO_ANCHOR.MIDDLE, label="MVP text")

s.notes_slide.notes_text_frame.text = (
    "Say it in one breath, no jargon: \"PARALLAX sits between the AI and the browser. "
    "It blocks dangerous actions, explains failures and records everything.\"\n"
    "TELL IT AS ONE STORY, in order (Priya's agent filling Alex's form): hidden text -> request to evil.com blocked live -> "
    "disguised Pay button asks first -> login expires, cause found -> Final Submit approved -> verified -> replay. Then /playground: press Replay, 14 vs 0. Script: docs/submission/DEMO_VIDEO_SCRIPT.md.\n"
    "Only mention CHRONOS/GHOST/MIRROR if a judge asks how it works.")

# ---------------------------------------------------------------- Slide 4: Tech stack
s = slides[3]; drop_template_hints(s)
set_subtitle(s, "Open-source, self-hosted stack: no page content or credentials leave our server.")
stack = [
    ("BROWSER LAYER", "Playwright · Chromium", "ARIA snapshots give a compact, stable page view; CDP routing lets us block requests below the model."),
    ("BACKEND / ENGINES", "Node.js 22 · TypeScript", "One typed language for engines, guard and demo server; native type-stripping, no build step."),
    ("AI / ML", "Qwen2.5-Coder-32B on vLLM", "Open weights served on our 2× NVIDIA L40S. The LLM only proposes; it has no execution authority."),
    ("DATA / AUDIT", "Append-only JSONL · SHA-256", "Every event hashed and timestamped: replayable, tamper-evident and easy to diff."),
    ("FRONTEND", "HTML/JS dashboard on Node", "Timeline replay, hypothesis board and the approval button; light enough to finish in 24 hrs."),
    ("TESTING", "node:test · Playwright", "Security suite proves exfil requests are aborted, risky clicks gated and secrets redacted."),
]
cw, ch, gx, gy = 3.75, 1.95, 0.325, 0.3
for i, (cat, tool, why) in enumerate(stack):
    col, row = i % 3, i // 3
    x = 0.7 + col * (cw + gx); y = 2.65 + row * (ch + gy)
    card(s, x, y, cw, ch, label="Stack card")
    text(s, x + 0.2, y + 0.15, cw - 0.4, 0.3, [[(cat, {"bold": True, "color": RUST, "size": 12})]], label="Stack category")
    text(s, x + 0.2, y + 0.45, cw - 0.4, 0.4, [[(tool, {"bold": True, "color": NAVY, "size": 16})]], label="Stack tool")
    text(s, x + 0.2, y + 0.9, cw - 0.4, 0.95, [why], size=13, color=GREY, label="Stack reason")

# ---------------------------------------------------------------- Slide 5: Architecture
s = slides[4]; drop_template_hints(s)
set_subtitle(s, "The LLM proposes; deterministic code disposes; every step is logged.")

rows = [
    ("INPUT", [("Target web app", "Scholarship portal"), ("Playwright observer", "ARIA · CDP events"),
               ("Network allowlist", "CDP routing · fail-closed"), ("Event store", "JSONL · SHA-256")]),
    ("PROCESS", [("MIRROR", "Simulate & rank fixes"), ("LLM (proposals)", "Qwen on vLLM · 2×L40S"),
                 ("GHOST", "Safe micro-probes"), ("CHRONOS", "State diff · last-good")]),
    ("OUTPUT", [("Policy engine", "TypeScript rules"), ("Human gate", "Approve in dashboard"),
                ("Executor", "Playwright actions"), ("Verifier", "Backend postconditions"), ("Timeline UI", "Replay & audit")]),
]
x0, xr = 2.15, 12.6
ys = [2.6, 4.02, 5.44]
bh = 0.95
geo = []
for ri, (lab, boxes) in enumerate(rows):
    y = ys[ri]
    pill(s, 0.7, y + 0.28, 1.15, 0.4, lab, fill=RUST if ri == 2 else NAVY, size=12)
    n = len(boxes); g = 0.4
    bw = (xr - x0 - (n - 1) * g) / n
    xs = []
    for bi, (h, t) in enumerate(boxes):
        x = x0 + bi * (bw + g); xs.append(x)
        hl = h in ("Policy engine", "Network allowlist", "Human gate")
        card(s, x, y, bw, bh, fill=TINT if hl else WHITE, lw=1.5, glow=False, label="Arch block")
        text(s, x + 0.08, y + 0.1, bw - 0.16, 0.4, [[(h, {"bold": True, "color": RUST if hl else NAVY, "size": 14})]], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, label="Block name")
        text(s, x + 0.08, y + 0.5, bw - 0.16, 0.36, [t], size=11, color=GREY, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, label="Block tech")
        if bi:
            if ri == 1:
                arrow(s, x - 0.04, y + bh / 2, x - g + 0.04, y + bh / 2)
            else:
                arrow(s, x - g + 0.04, y + bh / 2, x - 0.04, y + bh / 2)
    geo.append((xs, bw))
(xs0, bw0), (xs1, bw1), (xs2, bw2) = geo
arrow(s, xs0[-1] + bw0 / 2, ys[0] + bh + 0.03, xs1[-1] + bw1 / 2, ys[1] - 0.03)
arrow(s, xs2[0] + bw2 / 2, ys[1] + bh + 0.03, xs2[0] + bw2 / 2, ys[2] - 0.03)
text(s, 2.15, 6.5, 10.45, 0.35, [[("Blocked requests, policy violations and injection hints are written to the event store too; nothing is silently dropped.", {"italic": True})]],
     size=12, color=GREY, label="Arch caption")

# ---------------------------------------------------------------- Slide 6: Novelty
s = slides[5]; drop_template_hints(s)
set_subtitle(s, "Others make agents smarter. We make them safe to run and able to explain themselves.")

usp = [
    ("Capabilities, not detection", "Safety is enforced in the browser engine, so it holds even when the model is fooled."),
    ("Forensics for agents", "Brings DFIR-style timeline reconstruction to browser automation."),
    ("Experiments, not guesses", "GHOST tests hypotheses on the live flow before any fix is tried."),
]
text(s, 0.7, 2.55, 4.3, 0.35, [[("OUR USP", {"bold": True, "color": RUST, "size": 14})]], label="Section label")
for i, (h, b) in enumerate(usp):
    y = 2.95 + i * 1.3
    card(s, 0.7, y, 4.3, 1.15, label="USP card")
    text(s, 0.9, y + 0.12, 3.9, 0.35, [[(h, {"bold": True, "color": NAVY, "size": 15})]], label="USP title")
    text(s, 0.9, y + 0.48, 3.9, 0.62, [b], size=13, color=GREY, label="USP body")

cols = ["Capability", "LLM browser agents", "Scripted RPA / tests", "PARALLAX"]
data = [
    ("Adapts to new pages and tasks", "Yes", "No (brittle)", "Yes"),
    ("Allowlist enforced below the model", "No", "n/a", "Yes"),
    ("Approval gate read from the DOM", "Partial", "No", "Yes"),
    ("Root cause via controlled probes", "No", "No", "Yes"),
    ("Fix verified on backend state", "No", "Partial", "Yes"),
    ("Replayable, hashed evidence log", "Partial", "Partial", "Yes"),
]
text(s, 5.35, 2.55, 7.25, 0.35, [[("COMPARISON", {"bold": True, "color": RUST, "size": 14})]], label="Section label")
gf = s.shapes.add_table(len(data) + 1, 4, Inches(5.35), Inches(2.95), Inches(7.25), Inches(3.5))
name(gf, "Comparison table")
tbl = gf.table
for i, w in enumerate([2.85, 1.55, 1.6, 1.25]):
    tbl.columns[i].width = Inches(w)
tblPr = tbl._tbl.tblPr
tblPr.set("bandRow", "0"); tblPr.set("firstRow", "0")
sid = tblPr.find(qn("a:tableStyleId"))
if sid is not None:
    sid.text = "{5940675A-B579-460E-94D1-54222C63F5DA}"


def cell(r, c, t, fill, color, bold=False, align=PP_ALIGN.CENTER, size=13):
    ce = tbl.cell(r, c); ce.fill.solid(); ce.fill.fore_color.rgb = fill
    ce.margin_left = ce.margin_right = Inches(0.08); ce.margin_top = ce.margin_bottom = Inches(0.03)
    ce.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf = ce.text_frame; tf.text = ""; p = tf.paragraphs[0]; p.alignment = align
    rr = p.add_run(); rr.text = t; rr.font.size = Pt(size); rr.font.bold = bold
    rr.font.color.rgb = color; rr.font.name = BODY


for c, h in enumerate(cols):
    cell(0, c, h, NAVY if c < 3 else RUST, WHITE, True, PP_ALIGN.LEFT if c == 0 else PP_ALIGN.CENTER)
for r, row in enumerate(data, 1):
    for c, v in enumerate(row):
        if c == 0:
            cell(r, c, v, WHITE, INK, False, PP_ALIGN.LEFT)
        elif c == 3:
            cell(r, c, "✔ " + v, TINT, GREEN, True)
        else:
            col = GREEN if v == "Yes" else (RUST if v.startswith("No") else GREY)
            cell(r, c, v, WHITE, col, v != "n/a")
for r in range(len(data) + 1):
    tbl.rows[r].height = Inches(0.5)

# ---------------------------------------------------------------- Slide 7: Impact & Feasibility
s = slides[6]; drop_template_hints(s)
hw = (11.9 - 0.325) / 2
set_subtitle(s, "Measured on 14 attack techniques: 14 run with the agent alone, 0 with PARALLAX. 0 normal steps blocked.")

ba = [
    ("Hidden injection on the page", "Agent sends data to attacker’s site", "Request blocked in the browser, logged"),
    ("Agent reaches “Pay” / “Submit”", "AI decides on its own", "Pauses until a human approves"),
    ("Login expires mid-task", "Retries blindly, no root cause", "Exact step and cause found by probes"),
    ("“Did the fix work?”", "Unknown: screenshots only", "Verified on backend + full replay"),
]
gf = s.shapes.add_table(len(ba) + 1, 3, Inches(0.7), Inches(2.5), Inches(11.9), Inches(2.3))
name(gf, "Before after table")
tbl = gf.table
for i, w in enumerate([3.6, 4.0, 4.3]):
    tbl.columns[i].width = Inches(w)
tblPr = tbl._tbl.tblPr
tblPr.set("bandRow", "0"); tblPr.set("firstRow", "0")
sid = tblPr.find(qn("a:tableStyleId"))
if sid is not None:
    sid.text = "{5940675A-B579-460E-94D1-54222C63F5DA}"
for c, (h, f) in enumerate([("Situation", NAVY), ("BEFORE: agent alone", GREY), ("AFTER: agent + PARALLAX", RUST)]):
    cell(0, c, h, f, WHITE, True, PP_ALIGN.LEFT, 14)
for r, (sit, before, after) in enumerate(ba, 1):
    cell(r, 0, sit, WHITE, INK, True, PP_ALIGN.LEFT, 14)
    cell(r, 1, "✗  " + before, WHITE, RUST, False, PP_ALIGN.LEFT, 14)
    cell(r, 2, "✔  " + after, TINT, GREEN, True, PP_ALIGN.LEFT, 14)
for r in range(len(ba) + 1):
    tbl.rows[r].height = Inches(0.46)

yb, bh3 = 5.1, 1.78
card(s, 0.7, yb, hw, bh3, label="Feasibility card")
text(s, 0.9, yb + 0.12, hw - 0.4, bh3 - 0.2, [
    [("FEASIBILITY", {"bold": True, "color": RUST, "size": 13})],
    {"runs": [("Technical: ", {"bold": True}), ("policy guard + tests already in our repo; Playwright and vLLM are mature.", {})], "bullet": True},
    {"runs": [("Time: ", {"bold": True}), ("frozen scope (1 portal, 3 failures), 2 owners.", {})], "bullet": True},
    {"runs": [("Cost: ", {"bold": True}), ("₹0 licences or API fees; runs on our own 2× L40S.", {})], "bullet": True},
], size=13, space=3, label="Feasibility text")
card(s, 0.7 + hw + 0.325, yb, hw, bh3, label="Risk card")
text(s, 0.9 + hw + 0.325, yb + 0.12, hw - 0.4, bh3 - 0.2, [
    [("RISKS → MITIGATION", {"bold": True, "color": RUST, "size": 13})],
    {"runs": [("LLM unpredictable → ", {"bold": True}), ("guard is deterministic code", {})], "bullet": True},
    {"runs": [("GPU / Wi-Fi down → ", {"bold": True}), ("small local model + recorded run", {})], "bullet": True},
    {"runs": [("Real sites messy → ", {"bold": True}), ("controlled demo portal", {})], "bullet": True},
    {"runs": [("Scope creep → ", {"bold": True}), ("feature freeze, one rehearsed path", {})], "bullet": True},
], size=13, space=3, label="Risk text")

s.notes_slide.notes_text_frame.text = (
    "This is the before/after moment: read one row slowly (the injection row), then point at the AFTER column.\n"
    "Numbers come from `npm run eval` (docs/submission/BEFORE_AFTER.md): 14 attack techniques, 11 blocked, 3 paused for approval; "
    "7 of 8 normal steps ran freely, final submit asked once. Say: once the model is fooled, none of the 14 gets through. "
    "It is NOT a detection rate. Bonus story: the harness caught our own earlier guard letting 6 of 14 through.")

# ---------------------------------------------------------------- Slide 8: Business model
s = slides[7]; drop_template_hints(s)
set_subtitle(s, "Open-core: the safety guard is free; teams pay for the audit trail and compliance.")
bm = [
    ("TARGET CUSTOMERS", "Teams putting browser agents into regulated workflows: fintech, ed-tech, HR and e-gov service desks; plus QA/RPA teams."),
    ("REVENUE MODEL", "Free OSS guard SDK → Pro: hosted timeline and retention, per seat → Enterprise: on-prem + compliance reports, per agent."),
    ("GO-TO-MARKET", "Open-source the guard on GitHub/npm; plug-ins for Playwright and Browser Use; pilots with campus IT and admission portals."),
    ("KEY COSTS", "GPU inference (self-hosted open models, no per-token bills), event-log storage and a small engineering team."),
    ("PARTNERSHIPS", "Agent frameworks, cloud GPU providers, university IT departments and security / bug-bounty communities."),
    ("GROWTH PLAN", "Browser agents first, then API and desktop agents. Audit logs map to record-keeping duties (EU AI Act Art. 12, India DPDP Act)."),
]
for i, (h, b) in enumerate(bm):
    col, row = i % 3, i // 3
    x = 0.7 + col * (cw + gx); y = 2.65 + row * (ch + gy)
    card(s, x, y, cw, ch, fill=NAVY if i == 1 else WHITE, label="Business card")
    text(s, x + 0.2, y + 0.15, cw - 0.4, 0.3, [[(h, {"bold": True, "color": ORANGE if i == 1 else RUST, "size": 13})]], label="Business heading")
    text(s, x + 0.2, y + 0.5, cw - 0.4, 1.4, [b], size=15, color=WHITE if i == 1 else INK, label="Business body")


NOTES = {
    3: "Why each tool, in one line: Playwright gives a stable page view and lets us block requests below the AI; the model runs on our own GPUs, so no page data or passwords leave our server.",
    4: "Walk the arrows once, top to bottom. Key line: 'The LLM can only suggest. Every action passes the policy engine; risky ones need a human.'",
    5: ("Q&A PREP. 'ChatGPT Agent already asks before buying?' -> Yes, but the AI decides when to ask; ours is read from the page by code, so a fooled AI cannot skip it. "
        "'Isn't this just a firewall?' -> A firewall can't explain why a task failed or prove the fix worked. "
        "'What's not built yet?' -> Say it plainly: MIRROR simulation is basic in the MVP; we'll extend it after the hackathon. Never overclaim."),
    7: ("Close: 'Agents are coming either way. PARALLAX makes them safe enough to ship.' "
        "Show we're in it for real: 'We're open-sourcing the guard after the hackathon and want pilots with admission portals.' Then hand over to Q&A."),
}
for i, t in NOTES.items():
    slides[i].notes_slide.notes_text_frame.text = t

# ---------------------------------------------------------------- footer in layout
for layout in prs.slide_layouts:
    for sh in layout.shapes:
        if sh.has_text_frame and "<Team Name>" in sh.text_frame.text:
            for p in sh.text_frame.paragraphs:
                for r in p.runs:
                    r.text = r.text.replace("<Team Name>", "BL4CK_0P$").replace("<Team ID>", "7e709e42")

prs.save(OUT)
print("saved", OUT)
