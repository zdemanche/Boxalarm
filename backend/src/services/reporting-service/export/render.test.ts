import { describe, expect, it } from 'vitest';
import { tabularFromJson } from './buildReport.js';
import { renderCsv, renderPdf } from './render.js';

describe('export rendering', () => {
  it('escapes CSV cells and embeds the same fields in the PDF text', () => {
    const table = tabularFromJson('Dashboard', { activeMemberCount: 2, note: 'a, "b"' });
    const csv = renderCsv(table);
    expect(csv.split('\n')[0]).toBe('field,value');
    expect(csv).toContain('"a, ""b"""');
    expect(csv).toContain('activeMemberCount,2');
    const pdf = renderPdf(table).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('Dashboard');
    expect(pdf).toContain('activeMemberCount');
  });
});
