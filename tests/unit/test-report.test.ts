/** Акт проверки для клиента: вывод только из сравнения замеров с расчётом; текст экранируется, переносится. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { testReportSvg, verdictText, wrap } from '../../src/core/testReport';
import { readElab } from '../../src/storage/elab';

const load = async () => (await readElab(readFileSync(path.resolve(import.meta.dirname, '../../examples/пример-стабилизатор-lm317.elab')))).doc;

describe('Акт проверки', () => {
  test('LM317: без расчёта — «не сравнены»; с расчётом в допуске — «все в допуске»; вне допуска — «расхождения»', async () => {
    const d = await load();
    const rec = d.tests[0]!;
    assert.match(verdictText(rec).text, /не сравнены/);
    const m = rec.measurements[0]!;
    const withExp = { ...rec, measurements: [{ ...m, expected: { value: 5.04, band: 0.1, method: 'ngspice', revision: rec.revision, at: new Date().toISOString() } }] };
    assert.equal(verdictText(withExp).ok, true);
    assert.match(verdictText(withExp).text, /Все измерения \(1\) в пределах допуска/);
    const bad = { ...withExp, measurements: [{ ...withExp.measurements[0]!, measured: 3.3 }] };
    assert.equal(verdictText(bad).ok, false);
    const sheet = testReportSvg(d, { ...bad, notes: 'Клиент <Иванов> & сын' }, { workshop: 'Ремонт техники', client: 'Блок питания №5' });
    assert.ok(sheet.svg.includes('Акт проверки устройства'));
    assert.ok(sheet.svg.includes('Ремонт техники') && sheet.svg.includes('Блок питания №5'));
    assert.ok(sheet.svg.includes('РАСХОЖДЕНИЕ'));
    assert.ok(sheet.svg.includes('Клиент &lt;Иванов&gt; &amp; сын'), 'текст экранирован');
    assert.equal(sheet.widthMm, 210);
    assert.ok(sheet.heightMm >= 297);
  });

  test('перенос по словам и длинный отчёт растягивает лист', async () => {
    assert.deepEqual(wrap('раз два три четыре', 9), ['раз два', 'три', 'четыре']);
    assert.ok(wrap('x'.repeat(25), 10).every((l) => l.length <= 10));
    const d = await load();
    const rec = d.tests[0]!;
    const many = { ...rec, measurements: Array.from({ length: 60 }, (_, i) => ({ ...rec.measurements[0]!, id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` })) };
    assert.ok(testReportSvg(d, many).heightMm > 297);
  });
});
