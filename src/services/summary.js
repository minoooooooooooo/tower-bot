import { config } from '../config.js';
import { chatJson } from '../lib/ai.js';
import { COLORS, embed } from '../lib/embeds.js';
import { chunkLines } from './summary-source.js';

export const SUMMARY_KINDS = {
  general: {
    label: 'General',
    arLabel: 'ملخص عام',
    emoji: '🧭',
    brief: 'topics, news and decisions',
    emphasis:
      'Cover the topics discussed, news or announcements shared, decisions that were made, and anything that changed.',
  },
  tasks: {
    label: 'Action items',
    arLabel: 'ملخص المهام',
    emoji: '📌',
    brief: 'requests, problems and owners',
    emphasis:
      'Focus on actionable items: requests, suggestions, problems that need a solution, follow-ups, and who took each one. Ignore pure chatter.',
  },
  targeted: {
    label: 'Targeted',
    arLabel: 'ملخص موجّه',
    emoji: '🎯',
    brief: 'one topic, on request',
    emphasis:
      'Answer the requested focus using only the transcript. Include every message that relates to it and ignore everything else. If the transcript never covers it, say so in "answer" and leave the arrays empty.',
  },
};

export const KIND_KEYS = Object.keys(SUMMARY_KINDS);

/** Typed aliases, shared by `/summary run` and `/autoreport set`. */
export const KIND_ALIASES = {
  general: 'general',
  g: 'general',
  topics: 'general',
  tasks: 'tasks',
  task: 'tasks',
  items: 'tasks',
  todo: 'tasks',
  targeted: 'targeted',
  ask: 'targeted',
  focus: 'targeted',
};

const MAX_ITEMS = { topics: 12, decisions: 15, announcements: 10, tasks: 20, questions: 10, highlights: 6 };
const MAX_LENGTH = {
  headline: 500,
  topicTitle: 150,
  topicSummary: 900,
  entry: 600,
  item: 300,
  quote: 400,
  answer: 1500,
};

/**
 * Section furniture. Labels follow the language of the report body, not the
 * guild locale: an Arabic channel should not get English headings.
 */
export const LABELS = {
  en: {
    overview: 'Overview',
    sections: {
      answer: { field: '🎯 Answer', heading: 'Answer' },
      topics: { field: '📋 Key discussions', heading: 'Key discussions' },
      decisions: { field: '✅ Decisions made', heading: 'Decisions made' },
      announcements: { field: '📢 Announcements', heading: 'Announcements' },
      tasks: { field: '📌 Action items', heading: 'Action items' },
      questions: { field: '❓ Questions raised', heading: 'Questions raised' },
      highlights: { field: '💬 Highlights', heading: 'Highlights' },
    },
    topicFallback: 'Topic',
    continued: 'Part',
    messages: (count) => `${count} message${count === 1 ? '' : 's'}`,
    analyzed: (count) => `${count} message${count === 1 ? '' : 's'} analyzed`,
    window: (hours) => {
      if (hours <= 1) return 'Last hour';
      if (hours >= 48 && hours % 24 === 0) {
        return `Last ${hours / 24} days`;
      }
      return `Last ${hours} hours`;
    },
    channel: 'Channel',
    windowLabel: 'Window',
    requestedBy: 'Requested by',
    model: 'Model',
    focus: 'Focus',
    unknown: 'unknown',
    nothing: 'Nothing worth reporting in this window.',
  },
  ar: {
    overview: 'نظرة عامة',
    sections: {
      answer: { field: '🎯 الإجابة', heading: 'الإجابة' },
      topics: { field: '📋 مناقشات رئيسية', heading: 'مناقشات رئيسية' },
      decisions: { field: '✅ قرارات متخذه', heading: 'قرارات متخذه' },
      announcements: { field: '📢 إعلانات', heading: 'إعلانات' },
      tasks: { field: '📌 مهام', heading: 'مهام' },
      questions: { field: '❓ أسئلة مطروحة', heading: 'أسئلة مطروحة' },
      highlights: { field: '💬 أبرز المقولات', heading: 'أبرز المقولات' },
    },
    topicFallback: 'موضوع',
    continued: 'الجزء',
    messages: (count) => `${count} رسالة`,
    analyzed: (count) => `تم تحليل ${count} رسالة`,
    window: (hours) => {
      if (hours <= 1) return 'آخر ساعة';
      if (hours >= 48 && hours % 24 === 0) {
        const days = hours / 24;
        return `آخر ${days} ${days >= 3 && days <= 10 ? 'أيام' : 'يوم'}`;
      }
      return `آخر ${hours} ساعة`;
    },
    channel: 'القناة',
    windowLabel: 'الفترة',
    requestedBy: 'طلبها',
    model: 'النموذج',
    focus: 'التركيز',
    unknown: 'غير معروف',
    nothing: 'لا يوجد ما يستحق التلخيص في هذه الفترة.',
  },
};

const ARABIC_RANGE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;

/**
 * True when the report itself is written in Arabic, which decides the labels.
 * Uses the same 30% threshold as the export's direction check so headings and
 * page direction can never disagree.
 */
export function isArabicContent(data) {
  const sample = [
    data?.headline,
    data?.answer,
    ...(data?.topics ?? []).map((topic) => `${topic?.title ?? ''} ${topic?.summary ?? ''}`),
    ...(data?.decisions ?? []),
    ...(data?.tasks ?? []).map((task) => `${task?.task ?? ''} ${task?.owner ?? ''}`),
    ...(data?.questions ?? []),
    ...(data?.highlights ?? []).map((item) => `${item?.quote ?? ''} ${item?.author ?? ''}`),
  ]
    .filter(Boolean)
    .join(' ');

  const letters = sample.replace(/[\s\d\p{P}]/gu, '');

  if (letters.length < 12) return false;

  return (sample.match(ARABIC_RANGE) ?? []).length / letters.length > 0.3;
}

export function labelsFor(data) {
  return isArabicContent(data) ? LABELS.ar : LABELS.en;
}

const SYSTEM_PROMPT = [
  'You write operational summaries of a Discord channel for a server management team.',
  'Rules:',
  '- Use ONLY the transcript. Never invent names, numbers, links, or decisions.',
  '- Write in the language used most in the transcript (Arabic stays Arabic, English stays English).',
  '- Be specific about who said or proposed what when it matters.',
  '- Name people exactly as the transcript does: their display name, never a raw Discord handle.',
  '- When writing in Arabic, write names in Arabic letters: translate a meaningful name (It\'s Emad → عماد) or transliterate it phonetically (ShinIsekai → شين ايسكاي). Do not leave Latin handles inside an Arabic sentence.',
  '- Be exhaustive. Every distinct subject, decision, announcement, request, problem, number, date, link and name in the transcript must appear somewhere in the JSON. Do not merge unrelated subjects to save space, and do not drop minor points.',
  '- Prefer many specific entries over few general ones. Give each topic its own entry with 4-8 sentences covering who raised it, what was said, any numbers or links, and how it ended.',
  '- Aim for 700-1,200 words for a full day of chat. A short window can be shorter; never pad with filler or repeat yourself.',
  '- Skip greetings, spam, and small talk unless it is the topic.',
  '- Every topic has a short title and a 4-8 sentence summary. Decisions, announcements and questions are strings formatted as "short title — who/what/when".',
  '- Each transcript line ends with [id:1234567890]. Copy the id of the message that best supports a topic into its "id" field exactly; omit id when no single message supports the whole topic. Never invent an id.',
  '- "decisions" are choices the team made; "announcements" are news someone declared (a bot is ready, a feature launched); keep them separate.',
  '- Reply with a single JSON object and nothing else.',
  'JSON shape:',
  '{"headline":"one sentence overview","answer":"only for targeted summaries",',
  ' "topics":[{"title":"short label","summary":"4-8 sentences","id":"message id or empty"}],',
  ' "decisions":["short title — who decided it and under what condition"],',
  ' "announcements":["short title — what was announced and by whom"],',
  ' "tasks":[{"task":"what must be done","owner":"who took it, or empty"}],',
  ' "questions":["short question — context or why it matters"],',
  ' "highlights":[{"quote":"short verbatim quote","author":"display name"}]}',
  'Use empty arrays for anything that does not apply.',
].join('\n');

const REDUCE_PROMPT = [
  'You merge partial summaries of the same Discord channel into one final summary.',
  'Rules:',
  '- Deduplicate only true duplicates; keep every distinct point from every partial summary. Merging is not compressing.',
  '- The final summary must be at least as detailed as the partials. Never shorten for brevity.',
  '- Never invent facts that are not in the partial summaries.',
  '- Keep each topic\'s "id" when merging; never invent an id. If two topics merge, keep the id of the message that best supports the merged topic.',
  '- Write in the dominant language of the partial summaries.',
  '- Keep names in the script of that language: one person must not appear as "عماد" in one section and "e_a_0" elsewhere.',
  '- Reply with a single JSON object using exactly this shape:',
  '{"headline":"","answer":"","topics":[{"title":"","summary":"","id":""}],"decisions":[],"announcements":[],"tasks":[{"task":"","owner":""}],"questions":[],"highlights":[{"quote":"","author":""}]}',
].join('\n');

function clean(value, max) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Models drift: they add keys, return a string where an array belongs, or wrap
 * everything in an extra object. Everything downstream can rely on this shape.
 */
function cleanId(value) {
  const id = String(value ?? '').replace(/\D/g, '');
  return /^\d{17,20}$/.test(id) ? id : null;
}

/** `title — detail` keeps decisions/questions/announcements as strings while
 * still giving the renderer a heading and a paragraph to work with. */
function itemText(item) {
  if (item == null) return '';
  if (typeof item === 'string') return clean(item, MAX_LENGTH.entry);

  const title = item.title ?? item.decision ?? item.question ?? item.announcement ?? item.text;
  const summary = item.summary ?? item.detail ?? item.description ?? item.context;

  return clean([title, summary].filter(Boolean).join(' — '), MAX_LENGTH.entry);
}

export function normalizeSummary(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};

  const topics = list(data.topics)
    .map((topic) => ({
      title: clean(topic?.title ?? topic, MAX_LENGTH.topicTitle),
      summary: clean(topic?.summary ?? topic?.detail ?? '', MAX_LENGTH.topicSummary),
      id: cleanId(topic?.id ?? topic?.messageId ?? topic?.message_id),
    }))
    .filter((topic) => topic.title || topic.summary)
    .slice(0, MAX_ITEMS.topics);

  const decisions = list(data.decisions)
    .map(itemText)
    .filter(Boolean)
    .slice(0, MAX_ITEMS.decisions);

  const announcements = list(data.announcements)
    .map(itemText)
    .filter(Boolean)
    .slice(0, MAX_ITEMS.announcements);

  const tasks = list(data.tasks)
    .map((item) => ({
      task: clean(typeof item === 'string' ? item : (item?.task ?? item?.item), MAX_LENGTH.item),
      owner: clean(typeof item === 'string' ? '' : (item?.owner ?? item?.assignee), 80),
    }))
    .filter((item) => item.task)
    .slice(0, MAX_ITEMS.tasks);

  const questions = list(data.questions)
    .map(itemText)
    .filter(Boolean)
    .slice(0, MAX_ITEMS.questions);

  const highlights = list(data.highlights)
    .map((item) => ({
      quote: clean(typeof item === 'string' ? item : item?.quote, MAX_LENGTH.quote),
      author: clean(typeof item === 'string' ? '' : item?.author, 80),
    }))
    .filter((item) => item.quote)
    .slice(0, MAX_ITEMS.highlights);

  return {
    headline: clean(data.headline ?? data.overview ?? data.summary, MAX_LENGTH.headline),
    answer: clean(data.answer, MAX_LENGTH.answer),
    topics,
    decisions,
    announcements,
    tasks,
    questions,
    highlights,
  };
}

export function isEmptySummary(data) {
  return (
    !data?.headline &&
    !data?.answer &&
    (data?.topics?.length ?? 0) === 0 &&
    (data?.decisions?.length ?? 0) === 0 &&
    (data?.announcements?.length ?? 0) === 0 &&
    (data?.tasks?.length ?? 0) === 0 &&
    (data?.questions?.length ?? 0) === 0 &&
    (data?.highlights?.length ?? 0) === 0
  );
}

function buildUserPrompt({ kind, prompt, glossary, roster, chunk, index, total }) {
  const spec = SUMMARY_KINDS[kind] ?? SUMMARY_KINDS.general;
  const parts = [`Task: ${spec.emphasis}`];

  if (kind === 'targeted') {
    parts.push(`Focus requested by the team: """${String(prompt ?? '').slice(0, 500)}"""`);
  }

  if (total > 1) {
    parts.push(
      `This is part ${index + 1} of ${total} of the transcript. Summarize only this part; the parts are merged afterwards.`,
    );
  }

  if (roster?.length > 0) {
    parts.push(
      [
        'Speakers in this transcript. Use the name on the left exactly; the handle is only there so you can tell two spellings are the same person:',
        ...roster,
      ].join('\n'),
    );
  }

  if (glossary) {
    parts.push(`Server glossary (use these meanings when they appear):\n${glossary}`);
  }

  parts.push('Transcript:\n"""');
  parts.push(chunk);
  parts.push('"""');

  return parts.join('\n\n');
}

/**
 * Summarize transcript lines. One call for a short window; map-reduce for a
 * long one, which keeps each request inside the model's context.
 */
export async function summarizeTranscript({
  transcript,
  kind = 'general',
  prompt = null,
  glossary = '',
  roster = [],
  maxChars = config.ai.maxInputChars,
  onProgress = null,
}) {
  const chunks = chunkLines(transcript, maxChars);

  if (chunks.length === 0) return normalizeSummary({});

  if (chunks.length === 1) {
    const { data } = await chatJson({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt({
        kind,
        prompt,
        glossary,
        roster,
        chunk: chunks[0].join('\n'),
        index: 0,
        total: 1,
      }),
      maxTokens: 4096,
      timeoutMs: 180_000,
    });

    return normalizeSummary(data);
  }

  const partials = [];

  for (let index = 0; index < chunks.length; index += 1) {
    onProgress?.(index + 1, chunks.length);

    const { data } = await chatJson({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt({
        kind,
        prompt,
        glossary,
        roster,
        chunk: chunks[index].join('\n'),
        index,
        total: chunks.length,
      }),
      maxTokens: 2048,
      timeoutMs: 120_000,
    });

    partials.push(normalizeSummary(data));
  }

  onProgress?.(chunks.length, chunks.length);

  const { data } = await chatJson({
    system: REDUCE_PROMPT,
    user: `Merge these partial summaries into one. Keep every distinct point:\n\n${JSON.stringify(partials).slice(0, maxChars)}`,
    maxTokens: 4096,
    timeoutMs: 180_000,
  });

  return normalizeSummary(data);
}

// --- rendering --------------------------------------------------------------

const FIELD_LIMIT = 1024;
const MAX_FIELDS = 25;

// Discord rejects an embed whose text exceeds 6,000 characters, so sections are
// packed into as many embeds as needed instead of being cut.
const EMBED_CHAR_BUDGET = 5_600;
const MAX_EMBEDS = 8;
const MAX_TOTAL_FIELDS = MAX_FIELDS * MAX_EMBEDS;

/** Splits a section across as many fields as needed, keeping whole blocks. */
function pushSection(fields, name, blocks) {
  const text = blocks.filter((block) => String(block ?? '').trim()).join('\n\n');

  if (!text.trim()) return;

  const chunks = [];
  let current = '';

  for (const line of text.split('\n')) {
    if (current && current.length + line.length + 1 > FIELD_LIMIT - 8) {
      chunks.push(current);
      current = '';
    }

    current = current ? `${current}\n${line}` : line;
  }

  if (current) chunks.push(current);

  chunks.forEach((chunk, index) => {
    if (fields.length >= MAX_TOTAL_FIELDS) return;

    fields.push({
      name: chunks.length > 1 ? `${name} (${index + 1}/${chunks.length})` : name,
      value: chunk.slice(0, FIELD_LIMIT),
      inline: false,
    });
  });
}

/** "short title — details" becomes a heading plus a paragraph. */
export function splitItem(text) {
  const value = String(text ?? '').trim();
  const index = value.indexOf(' — ');

  if (index <= 0) return { title: value, summary: '' };

  return { title: value.slice(0, index), summary: value.slice(index + 3) };
}

export function summaryFields(data, labels = LABELS.en) {
  const fields = [];

  if (data.answer) pushSection(fields, labels.sections.answer.field, [data.answer]);

  pushSection(
    fields,
    labels.sections.topics.field,
    data.topics.map((topic) => {
      const heading = `**${topic.title || labels.topicFallback}**${
        topic.url ? ` [Jump](${topic.url})` : ''
      }`;
      return topic.summary ? `${heading}\n${topic.summary}` : heading;
    }),
  );

  const itemBlocks = (items) =>
    items.map((item) => {
      const { title, summary } = splitItem(item);
      return summary ? `**${title}**\n${summary}` : `**${title}**`;
    });

  pushSection(fields, labels.sections.decisions.field, itemBlocks(data.decisions));
  pushSection(fields, labels.sections.announcements.field, itemBlocks(data.announcements ?? []));

  pushSection(
    fields,
    labels.sections.tasks.field,
    data.tasks.map((task) => `**${task.task}**${task.owner ? ` — ${task.owner}` : ''}`),
  );

  pushSection(fields, labels.sections.questions.field, itemBlocks(data.questions));

  pushSection(
    fields,
    labels.sections.highlights.field,
    data.highlights.map((item) => `> ${item.quote}${item.author ? `\n> — ${item.author}` : ''}`),
  );

  return fields;
}

/**
 * `meta` carries everything the reader needs to judge the summary: which
 * channel, which window, how many messages, and who asked for it.
 */
export function renderSummary({ data, meta }) {
  const labels = labelsFor(data);
  const fields = summaryFields(data, labels);
  const computedHours =
    Number.isFinite(meta.rangeStart) && Number.isFinite(meta.rangeEnd)
      ? Math.max(1, Math.round((meta.rangeEnd - meta.rangeStart) / 3_600_000))
      : 24;
  const hours = meta.hours ?? computedHours;
  const windowText = meta.scheduleText ?? labels.window(hours);
  const analyzedText = meta.scheduleText
    ? `${meta.messageCount} message${meta.messageCount === 1 ? '' : 's'} analyzed`
    : labels.analyzed(meta.messageCount);
  const footer = [windowText, analyzedText].filter(Boolean).join(' | ');

  const title = `${labels.overview}: #${meta.channelName ?? meta.channelId}`;
  const description = data.headline || undefined;

  // Pack fields into embeds: 25 fields and ~5,600 characters each. A long report
  // becomes two or three embeds instead of a rejected message.
  const groups = [];
  let current = [];
  let used = (title.length + (description?.length ?? 0) + footer.length) + 40;

  for (const field of fields) {
    const cost = field.name.length + field.value.length + 1;

    if (current.length > 0 && (current.length >= MAX_FIELDS || used + cost > EMBED_CHAR_BUDGET)) {
      groups.push(current);
      current = [];
      used = 40;
    }

    current.push(field);
    used += cost;
  }

  if (current.length > 0) groups.push(current);

  const truncated = groups.length > MAX_EMBEDS;
  const kept = groups.length > 0 ? groups.slice(0, MAX_EMBEDS) : [[]];

  const embeds = kept.map((group, index) =>
    embed({
      title: (index === 0
        ? title
        : `${labels.continued} ${index + 1}/${kept.length}`
      ).slice(0, 256),
      description:
        index === 0 ? (description ?? (fields.length === 0 ? labels.nothing : undefined)) : undefined,
      fields: group,
      footer: index === 0 ? footer.slice(0, 200) : undefined,
      color: COLORS.primary,
      timestamp: index === 0,
    }),
  );

  return { embeds, truncated, markdown: summaryMarkdown({ data, meta }) };
}

/** Plain markdown, reused by the HTML/PDF export. */
export function summaryMarkdown({ data, meta }) {
  const labels = labelsFor(data);
  const computedHours =
    Number.isFinite(meta.rangeStart) && Number.isFinite(meta.rangeEnd)
      ? Math.max(1, Math.round((meta.rangeEnd - meta.rangeStart) / 3_600_000))
      : 24;
  const hours = meta.hours ?? computedHours;
  const lines = [`# ${labels.overview}: #${meta.channelName ?? meta.channelId}`, ''];

  if (data.headline) lines.push(`_${data.headline}_`, '');
  if (data.answer) lines.push(`## ${labels.sections.answer.heading}`, '', data.answer, '');

  if (data.topics.length > 0) {
    lines.push(`## ${labels.sections.topics.heading}`, '');

    for (const topic of data.topics) {
      lines.push(
        `### ${topic.title}${topic.url ? ` [Jump](${topic.url})` : ''}`,
        '',
        topic.summary,
        '',
      );
    }
  }

  const itemSection = (title, items) => {
    if (items.length === 0) return;

    lines.push(`## ${title}`, '');

    for (const item of items) {
      const { title: itemTitle, summary } = splitItem(item);
      lines.push(summary ? `### ${itemTitle}\n\n${summary}` : `- ${itemTitle}`);
    }

    lines.push('');
  };

  itemSection(labels.sections.decisions.heading, data.decisions);
  itemSection(labels.sections.announcements.heading, data.announcements ?? []);

  if (data.tasks.length > 0) {
    lines.push(`## ${labels.sections.tasks.heading}`, '');

    for (const task of data.tasks) {
      lines.push(`- [ ] ${task.task}${task.owner ? ` — **${task.owner}**` : ''}`);
    }

    lines.push('');
  }

  itemSection(labels.sections.questions.heading, data.questions);

  if (data.highlights.length > 0) {
    lines.push(`## ${labels.sections.highlights.heading}`, '');

    for (const item of data.highlights) {
      lines.push(`> ${item.quote}`);

      if (item.author) lines.push(`> — ${item.author}`);

      lines.push('');
    }
  }

  lines.push(
    '---',
    '',
    `${labels.channel}: #${meta.channelName ?? meta.channelId} · ${labels.messages(meta.messageCount)}`,
    meta.scheduleText ?? labels.window(hours),
    `${labels.requestedBy}: ${meta.requestedBy ?? labels.unknown} · ${labels.model}: ${meta.model ?? labels.unknown}`,
  );

  if (meta.prompt) lines.push(`${labels.focus}: ${meta.prompt}`);

  return lines.join('\n');
}
