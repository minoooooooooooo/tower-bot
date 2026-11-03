import { LABELS, SUMMARY_KINDS, splitItem } from './summary.js';

const RTL = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function strong(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function paragraph(text) {
  return `<p dir="auto">${strong(text)}</p>`;
}

function section(title, body) {
  return body ? `<section><h2>${escapeHtml(title)}</h2>${body}</section>` : '';
}

function stamp(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ms));
}

/** Rough direction detection so Arabic reports are not laid out backwards. */
export function detectDirection(sample) {
  const text = String(sample ?? '');
  const letters = text.replace(/[\s\d\p{P}]/gu, '');
  const rtl = (text.match(new RegExp(RTL.source, 'g')) ?? []).length;

  return letters.length > 0 && rtl / letters.length > 0.3 ? 'rtl' : 'ltr';
}

/**
 * A self-contained HTML file. Browsers print this to PDF with the user's own
 * Arabic fonts (Print → Save as PDF), which beats shipping a PDF whose Arabic
 * would need custom shaping and font embedding.
 */
export function buildSummaryHtml({ data, meta }) {
  const spec = SUMMARY_KINDS[meta.kind] ?? SUMMARY_KINDS.general;
  const sample = [data.headline, data.answer, ...data.topics.map((t) => t.summary)].join(' ');
  const dir = detectDirection(sample);
  const labels = dir === 'rtl' ? LABELS.ar : LABELS.en;
  const timeZone = meta.timeZone ?? 'UTC';
  const kindLabel = dir === 'rtl' ? spec.arLabel : spec.label;
  const title = `${labels.overview}: #${meta.channelName ?? meta.channelId}`;

  const topics = data.topics
    .map(
      (topic) =>
        `<article class="topic"><h3 dir="auto">${strong(topic.title)}${
          topic.url ? ` <a href="${escapeHtml(topic.url)}">Jump</a>` : ''
        }</h3>${paragraph(topic.summary)}</article>`,
    )
    .join('');

  const articles = (items) =>
    items
      .map((item) => {
        const { title: itemTitle, summary } = splitItem(item);

        return `<article class="topic"><h3 dir="auto">${strong(itemTitle)}</h3>${
          summary ? paragraph(summary) : ''
        }</article>`;
      })
      .join('');

  const tasks =
    data.tasks.length > 0
      ? `<ul class="tasks">${data.tasks
          .map(
            (task) =>
              `<li dir="auto"><span class="box"></span>${strong(task.task)}${
                task.owner ? ` <span class="owner">— ${escapeHtml(task.owner)}</span>` : ''
              }</li>`,
          )
          .join('')}</ul>`
      : '';

  const highlights =
    data.highlights.length > 0
      ? data.highlights
          .map(
            (item) =>
              `<blockquote dir="auto">${escapeHtml(item.quote)}${
                item.author ? `<cite>— ${escapeHtml(item.author)}</cite>` : ''
              }</blockquote>`,
          )
          .join('')
      : '';

  const html = `<!doctype html>
<html lang="${dir === 'rtl' ? 'ar' : 'en'}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 40px 28px 64px; max-width: 820px;
    font-family: "Segoe UI", "Noto Naskh Arabic", "Noto Sans Arabic", Tahoma, Arial, sans-serif;
    font-size: 15px; line-height: 1.65; color: #1b1d22; background: #fff;
  }
  header { border-bottom: 3px solid #5865f2; padding-bottom: 16px; margin-bottom: 28px; }
  h1 { font-size: 26px; margin: 0 0 6px; line-height: 1.25; }
  .subtitle { color: #4b5162; margin: 0 0 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; color: #3d4250; }
  .chip { background: #eef0ff; border-radius: 999px; padding: 3px 10px; }
  .headline { font-size: 17px; font-weight: 600; margin: 0 0 24px; padding: 14px 16px;
    background: #f5f6ff; border-inline-start: 4px solid #5865f2; border-radius: 6px; }
  section { margin: 0 0 26px; break-inside: avoid; }
  h2 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: #5a6072;
    margin: 0 0 10px; padding-bottom: 6px; border-bottom: 1px solid #e3e5ec; }
  h3 { font-size: 15px; margin: 16px 0 4px; }
  p { margin: 0 0 8px; }
  ul { margin: 0; padding-inline-start: 20px; }
  li { margin-bottom: 6px; }
  ul.tasks { list-style: none; padding-inline-start: 0; }
  ul.tasks li { display: flex; gap: 10px; align-items: flex-start; }
  .box { flex: none; width: 14px; height: 14px; margin-top: 4px; border: 1.5px solid #9aa0b4; border-radius: 3px; }
  .owner { color: #4b5162; font-style: italic; }
  blockquote { margin: 0 0 12px; padding: 8px 14px; border-inline-start: 3px solid #d4d7e3;
    background: #fafafc; color: #2c303c; }
  blockquote cite { display: block; margin-top: 4px; font-size: 12px; color: #5a6072; font-style: normal; }
  footer { margin-top: 36px; padding-top: 14px; border-top: 1px solid #e3e5ec; font-size: 12px; color: #5a6072; }
  .hint { background: #fff8e1; border: 1px solid #ffe08a; border-radius: 6px;
    padding: 10px 14px; font-size: 13px; margin: 0 0 24px; }
  @media print {
    body { padding: 0; max-width: none; font-size: 12pt; }
    .hint { display: none; }
    header { margin-bottom: 18px; }
    @page { margin: 18mm; }
  }
</style>
</head>
<body>
<header>
  <h1 dir="auto">${escapeHtml(title)}</h1>
  <p class="subtitle" dir="auto">${escapeHtml(data.headline || spec.brief)}</p>
  <div class="chips">
    <span class="chip">${escapeHtml(stamp(meta.rangeStart, timeZone))} → ${escapeHtml(stamp(meta.rangeEnd, timeZone))}</span>
    <span class="chip">${escapeHtml(labels.messages(meta.messageCount))}</span>
    <span class="chip">${escapeHtml(meta.model ?? '')}</span>
  </div>
</header>
<p class="hint">${
    dir === 'rtl'
      ? 'للحصول على PDF: اطبع الصفحة (Ctrl/Cmd + P) ثم اختر «حفظ كـ PDF». يظهر النص العربي بخطوط جهازك.'
      : 'To get a PDF: Print (Ctrl/Cmd + P) → “Save as PDF”. Arabic text renders with your system fonts.'
  }</p>
${data.headline ? `<p class="headline" dir="auto">${escapeHtml(data.headline)}</p>` : ''}
${section(labels.sections.answer.heading, data.answer ? paragraph(data.answer) : '')}
${section(labels.sections.topics.heading, topics)}
${section(labels.sections.decisions.heading, articles(data.decisions))}
${section(labels.sections.announcements.heading, articles(data.announcements ?? []))}
${section(labels.sections.tasks.heading, tasks)}
${section(labels.sections.questions.heading, articles(data.questions))}
${section(labels.sections.highlights.heading, highlights)}
<footer dir="auto">
  ${escapeHtml(labels.requestedBy)} ${escapeHtml(meta.requestedBy ?? labels.unknown)} · ${escapeHtml(kindLabel)}
  ${meta.prompt ? `<br>${escapeHtml(labels.focus)}: ${escapeHtml(meta.prompt)}` : ''}
  <br>${dir === 'rtl' ? 'أُنشئ في' : 'Generated'} ${escapeHtml(new Date(meta.generatedAt ?? Date.now()).toISOString())}
</footer>
</body>
</html>`;

  const safeName = String(meta.channelName ?? meta.channelId ?? 'channel').replace(/[^a-z0-9_-]+/gi, '-');
  const stampPart = new Date(meta.rangeEnd).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

  return {
    buffer: Buffer.from(html, 'utf8'),
    filename: `summary-${safeName}-${stampPart}.html`,
  };
}
