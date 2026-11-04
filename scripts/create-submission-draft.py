"""Create the truthful two-page Round 1 readiness draft."""
from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak

output = Path('outputs/SecureForge-Round1-Writeup-DRAFT.pdf')
output.parent.mkdir(exist_ok=True)
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='BodySF', fontName='Helvetica', fontSize=9.5, leading=13, spaceAfter=7))
styles.add(ParagraphStyle(name='SectionSF', fontName='Helvetica-Bold', fontSize=12, leading=15, spaceBefore=9, spaceAfter=6))
styles.add(ParagraphStyle(name='SmallSF', fontName='Helvetica', fontSize=8, leading=10))
styles.add(ParagraphStyle(name='BannerSF', fontName='Helvetica-Bold', fontSize=10, leading=14, textColor=colors.HexColor('#9a3412'), spaceAfter=10))
story = []
def para(text, style='BodySF'):
    story.append(Paragraph(text, styles[style]))
def section(title):
    para(title, 'SectionSF')
def footer(canvas, doc):
    canvas.setStrokeColor(colors.HexColor('#cbd5e1'))
    canvas.line(18*mm, 16*mm, 192*mm, 16*mm)
    canvas.setFont('Helvetica', 8)
    canvas.setFillColor(colors.HexColor('#475569'))
    canvas.drawString(18*mm, 11*mm, 'SecureForge | Readiness draft | 4 November 2026')
    canvas.drawRightString(192*mm, 11*mm, str(doc.page))

para('SecureForge', 'Title')
para('ROUND 1 READINESS DRAFT - live-model demo and video pending', 'BannerSF')
section('Team')
para('Aditya Ranjan (@kvianAR) and Shubhaang Kataruka (@S-h-u-b-h-1). Team name, Team ID and each member\'s college or employer are pending confirmation. Roles cover Build, Defend and Prove with shared integration review.')
section('Starting point')
para('Custom SecureForge extension and tools built from scratch, using the official TrueForge SDK and runtime. This branch extends the shared SecureForge core-agent foundation. It does not fork TrueForge. The executable agent definition is src/agent.mjs. Public repository <link href="https://github.com/S-h-u-b-h-1/SecureForge">github.com/S-h-u-b-h-1/SecureForge</link>.')
section('Architecture on TrueForge')
para('The VS Code client creates TrueForge sessions and streams turns through SDK 0.182.0 against local runtime 0.183.0. It registers one temporary authenticated loopback MCP connector per run. The model chooses read_file, search_workspace, lookup_symbol, propose_edit, propose_batch and separately approved run_command calls. Provider credentials stay in TrueForge.')
para('TrueForge approvals gate proposal staging. The extension then renders immutable hash-linked proposals for independent human hunk decisions. One WorkspaceEdit applies accepted batch changes to buffers. Guarded Undo checks versions and hashes. Save is explicit. Cancellation discards pending proposals and closes the bridge. Command approval is separate, shell execution is disabled and receipts are bounded and redacted.')
section('How context is selected')
para('Automatic lexical retrieval scores task terms in paths and source lines, then boosts related tests and documentation. Explicit file/symbol mentions and the inline selection\'s file receive priority. Each excerpt shows path, lines, hash and selection reason. Default serialized context budget is 24,000 UTF-8 bytes, adjustable from 2,000 to 96,000. At most 12 excerpts are selected after scanning at most 4 MiB across 2,500 candidates. Token counts are approximate bytes/3 estimates.')
para('Repository excerpts are marked untrusted. Reads exclude restricted names, symlinks, binary data and oversized files. Lexical lookup does not infer callers or AST relationships. A pinned Flask rehearsal retrieved CLI source, tests and documentation without explicit filenames. A real-model recording must still demonstrate its usefulness.')
section('Model setup')
para('The current TrueForge catalog is empty. Production-model A/B runs and provider cost measurement were skipped. Runtime/SDK/MCP/editor checks used a deterministic local inference fixture, which does not prove model reasoning. Configure a provider in TrueForge, then set secureforge.model to its model FQN. Example settings and agent spec are included. Actual model, provider location and measured cost must be entered after the official run.')

story.append(PageBreak())
section('Scorecard')
para('Every video timestamp is pending. The evidence below describes local checks and implementation status. It does not assign competition points.')
rows = [['Criterion', 'Video time', 'Current evidence and remaining demonstration']]
entries = [
('A1 Inline edit', 'Pending', 'Selection guard and per-hunk review implemented. Show official Task A in the editor.'),
('A2 Agent mode', 'Pending', '2-8-file staging supported. Autonomous three-file Task B discovery requires a real model.'),
('A3 Streaming and cancellation', 'Pending', 'Runtime stream and cancellation safety tested. Show responsive editing during generation.'),
('B1 Context assembly', 'Pending', 'Budgeted retrieval, paths and reasons implemented. Flask source/test/doc retrieval checked.'),
('B2 Diff safety', 'Pending', 'Real editor apply, per-hunk rejection and guarded Undo verified. Show these on screen.'),
('B3 Resilience (Task C)', 'Pending', 'Actual SDK unreachable-endpoint check preserves Flask hashes and Git status. No automatic fallback or backoff.'),
('B4 TrueForge integration depth', 'Pending', 'SDK sessions, authenticated MCP and approvals verified with fixture inference. Advanced harness feature demonstration pending.'),
('C1 Video', 'Pending', 'A/B/C storyboard prepared. The required four-minute editor recording has not been created.'),
('C2 Write-up', 'Pending', 'Eight headings included. Team metadata, real model/cost and video timestamps must be completed.'),
]
for entry in entries:
    rows.append([Paragraph(value, styles['SmallSF']) for value in entry])
table = Table(rows, colWidths=[39*mm, 22*mm, 113*mm], repeatRows=1, hAlign='LEFT')
table.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#e2e8f0')),
    ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
    ('FONTSIZE', (0,0), (-1,0), 9),
    ('VALIGN', (0,0), (-1,-1), 'TOP'),
    ('BOX', (0,0), (-1,-1), .5, colors.HexColor('#cbd5e1')),
    ('INNERGRID', (0,0), (-1,-1), .3, colors.HexColor('#cbd5e1')),
    ('LEFTPADDING', (0,0), (-1,-1), 7), ('RIGHTPADDING', (0,0), (-1,-1), 7),
    ('TOPPADDING', (0,0), (-1,-1), 6), ('BOTTOMPADDING', (0,0), (-1,-1), 6),
]))
story.append(table)
section('Tools used')
para('Codex assisted implementation, tests and documentation. Node.js, the official TrueForge SDK/runtime, VS Code, esbuild and vsce provide the extension workflow. Python 3.12, pytest 8, Flask 3.1.3, ReportLab and Poppler support rehearsal and document checks. No production-model API cost was measured.')
section('Known limitations and what you would do with another month')
para('The fixed Flask edits were manually specified reference changes. Task A false-value checks and 59 Task B CLI tests passed, including masked JSON and help registration. This evidence does not establish autonomous official-task success. Task C has local SDK failure evidence, while editor responsiveness still needs recording. Team details, the final video, final scorecard and portal submission remain open.')
para('Security findings use four narrow patterns plus bounded same-function Python request-input traces. They remain candidates until controlled proof supports them. Exploitability proof is limited to the owned traversal fixture. Redaction is best effort. New-file edits, persistent proposals, automatic model fallback, complete authorization analysis and a demonstrated advanced TrueForge context-engineering feature remain future work.')
para('With another month, prioritize real-model evaluations, recording and scoring the official tasks, AST-aware context and input tracing, transaction-safe new-file review, and measured harness compaction or deferred tool loading. Preserve human edit approval and evidence boundaries throughout.')
SimpleDocTemplate(str(output), pagesize=(210*mm, 297*mm), rightMargin=18*mm, leftMargin=18*mm,
                  topMargin=16*mm, bottomMargin=22*mm, title='SecureForge Round 1 Readiness Draft', author='SecureForge').build(story, onFirstPage=footer, onLaterPages=footer)
print(output)
