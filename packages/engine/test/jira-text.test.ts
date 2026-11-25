import { describe, expect, it } from 'vitest';
import { flattenJiraDescription, jiraCriteriaSection, MAX_JIRA_CRITERIA, MAX_JIRA_DESCRIPTION, quoteForm } from '../src/jira-text.js';

// Synthetic tickets only: the repository is public, so no real work
// ticket is ever test data.

const text = (value: string, marks?: string[]) => ({ type: 'text', text: value, ...(marks ? { marks: marks.map((type) => ({ type })) } : {}) });
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content });
const heading = (level: number, value: string) => ({ type: 'heading', attrs: { level }, content: [text(value)] });
const item = (...content: unknown[]) => ({ type: 'listItem', content });
const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });

describe('flattenJiraDescription', () => {
  it('flattens a rich-text document to lines: headings, bold lines, bullets, numbers and tasks', () => {
    const description = doc(
      paragraph(text('Webhook deliveries are retried.')),
      heading(2, 'Acceptance criteria'),
      { type: 'bulletList', content: [item(paragraph(text('A failed delivery is retried '), text('three', ['strong']), text(' times'))), item(paragraph(text('Retries back off')), { type: 'bulletList', content: [item(paragraph(text('first after 1s')))] })] },
      paragraph(text('Notes:', ['strong'])),
      { type: 'orderedList', attrs: { order: 3 }, content: [item(paragraph(text('third'))), item(paragraph(text('fourth')))] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [text('done one')] }, { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('open one')] }] },
      paragraph(text('Line one'), { type: 'hardBreak' }, text('line two '), { type: 'mention', attrs: { text: '@Pat' } }),
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] },
    );
    expect(flattenJiraDescription(description)).toBe(
      [
        'Webhook deliveries are retried.',
        '',
        '## Acceptance criteria',
        '',
        '- A failed delivery is retried three times',
        '- Retries back off',
        '  - first after 1s',
        '',
        '**Notes:**',
        '',
        '3. third',
        '4. fourth',
        '',
        '- [x] done one',
        '- [ ] open one',
        '',
        'Line one',
        'line two @Pat',
      ].join('\n'),
    );
  });

  it('keeps a markdown or wiki description as Jira sent it, and reads anything else as empty', () => {
    expect(flattenJiraDescription('## AC\r\n- one')).toBe('## AC\n- one');
    expect(flattenJiraDescription(null)).toBe('');
    expect(flattenJiraDescription(42)).toBe('');
  });

  it('cuts a description past the size cap at a line, saying so', () => {
    const long = `${'word '.repeat(10)}\n`.repeat(MAX_JIRA_DESCRIPTION / 20);
    const flat = flattenJiraDescription(long);
    expect(flat.length).toBeLessThan(MAX_JIRA_DESCRIPTION + 100);
    expect(flat.endsWith(`[… cut: the description is longer than ${MAX_JIRA_DESCRIPTION} characters]`)).toBe(true);
  });
});

describe('jiraCriteriaSection', () => {
  const quotes = (description: string, wanted = 'Acceptance criteria') => jiraCriteriaSection(description, wanted)?.map((each) => each.text);

  it('reads the bullets under a heading, matched case-insensitively with a trailing colon, with their lines', () => {
    const description = ['Intro words.', '', '### acceptance Criteria:', '', '- Retries three times', '* Backs off', '', '## Notes', '- not a criterion'].join('\n');
    expect(jiraCriteriaSection(description, 'Acceptance criteria')).toEqual([
      { text: 'Retries three times', line: 5 },
      { text: 'Backs off', line: 6 },
    ]);
  });

  it('reads the section under a bold line, as Jira users often write in place of a heading', () => {
    const flat = flattenJiraDescription(
      doc(
        paragraph(text('Acceptance criteria:', ['strong'])),
        { type: 'bulletList', content: [item(paragraph(text('Retries three times'))), item(paragraph(text('Backs off')))] },
        paragraph(text('Out of scope', ['strong'])),
        { type: 'bulletList', content: [item(paragraph(text('Dead-letter queue')))] },
      ),
    );
    expect(quotes(flat)).toEqual(['Retries three times', 'Backs off']);
    expect(quotes('__Acceptance criteria__\n- one')).toEqual(['one']);
    expect(quotes('*Acceptance criteria*:\n- wiki bold')).toEqual(['wiki bold']);
    expect(quotes('h3. Acceptance criteria\n* wiki heading')).toEqual(['wiki heading']);
  });

  it('reads numbered items and task items, nested ones too, and an item’s broken lines with it', () => {
    const description = ['## Acceptance criteria', '1. First', '2) Second', '   carried on', '   - nested', '- [ ] Open task', '- [x] Done task'].join('\n');
    expect(quotes(description)).toEqual(['First', 'Second carried on', 'nested', 'Open task', 'Done task']);
  });

  it('reads a Given/When/Then scenario as one criterion, starting at its Given', () => {
    const description = [
      '**Acceptance Criteria**',
      'Scenario: a delivery fails',
      'Given a webhook that answers 500',
      'When a delivery is made',
      'Then it is retried three times',
      'And the last failure is logged',
      '',
      'Given a webhook that answers 200',
      'then it is not retried',
      '',
      'Thanks!',
    ].join('\n');
    expect(jiraCriteriaSection(description, 'Acceptance criteria')).toEqual([
      { text: 'Given a webhook that answers 500 When a delivery is made Then it is retried three times And the last failure is logged', line: 3 },
      { text: 'Given a webhook that answers 200 then it is not retried', line: 8 },
    ]);
  });

  it('finds no section when there is no such heading or bold line, and an empty one when the heading lists nothing', () => {
    expect(jiraCriteriaSection('Just a description.\n- a bullet', 'Acceptance criteria')).toBeUndefined();
    expect(jiraCriteriaSection('Acceptance criteria\n- plain words are no heading', 'Acceptance criteria')).toBeUndefined();
    expect(jiraCriteriaSection('', 'Acceptance criteria')).toBeUndefined();
    expect(jiraCriteriaSection('## Acceptance criteria\n\n## Next', 'Acceptance criteria')).toEqual([]);
  });

  it('reads under the configured heading, and passes over one that lists nothing for a later one', () => {
    expect(quotes('## Definition of done\n- shipped', 'Definition of done:')).toEqual(['shipped']);
    expect(quotes('## Acceptance criteria\nTBD\n\n## Acceptance criteria\n- real one')).toEqual(['real one']);
  });

  it('caps the criteria a ticket gives', () => {
    const description = ['## Acceptance criteria', ...Array.from({ length: MAX_JIRA_CRITERIA + 10 }, (_, index) => `- criterion ${index + 1}`)].join('\n');
    expect(quotes(description)).toHaveLength(MAX_JIRA_CRITERIA);
  });
});

describe('quoteForm', () => {
  it('drops layout marks and folds white space, keeping every word in its order', () => {
    expect(quoteForm('## Acceptance criteria\n\n- [ ] Retries **three** times\n  1. backs   off')).toBe('Acceptance criteria Retries three times backs off');
    expect(quoteForm('> quoted\n* bullet')).toBe('quoted bullet');
    expect(quoteForm('Retries three times')).not.toBe(quoteForm('Retries 3 times'));
  });
});
