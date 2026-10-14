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

  it('paginates so no row is cut off', () => {
    const rows = Array.from({ length: 150 }, (_, index) => [`field${index}`, `value${index}`]);
    const pdf = renderPdf({ title: 'LOSAP', headers: ['field', 'value'], rows }).toString('latin1');
    const pageCount = (pdf.match(/\/Type \/Page /g) ?? []).length;
    expect(pageCount).toBeGreaterThan(1);
    expect(pdf).toContain(`/Count ${pageCount}`);
    expect(pdf).toContain('(field149 | value149) Tj');
    for (const stream of pdf.split('stream\n').slice(1)) {
      expect((stream.match(/ Tj /g) ?? []).length).toBeLessThanOrEqual(60);
    }
  });

  it('points every xref entry at its object', () => {
    const rows = Array.from({ length: 150 }, (_, index) => [`field${index}`, `value${index}`]);
    const pdf = renderPdf({ title: 'LOSAP', headers: ['field', 'value'], rows }).toString('latin1');
    const entries = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
    expect(entries.length).toBeGreaterThan(4);
    entries.forEach((offset, index) => {
      expect(pdf.slice(offset).startsWith(`${index + 1} 0 obj`)).toBe(true);
    });
  });

  it('wraps a line wider than the page', () => {
    const pdf = renderPdf({ title: 't', headers: ['h'], rows: [['x'.repeat(200)]] });
    expect(pdf.toString('latin1')).not.toContain('x'.repeat(81));
  });
});
