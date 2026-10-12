/**
 * Типовые SPICE-шаблоны, общие для встроенного справочника и редактора деталей (своя деталь категории
 * «реле», «потенциометр» и т. п. сразу получает рабочую модель с параметрами на схеме).
 */
import type { SimModel } from './model';

type M = Omit<SimModel, 'id'>;
const std = (name: string, text: string[], source: string): M => ({ name, kind: text[0]!.startsWith('X') ? 'spice-subckt' : 'spice-primitive', text: text.join('\n'), source, verified: false });

/** Трансформатор: индуктивность первичной обмотки и коэффициент трансформации; связь 0,995. */
export const TR_GENERIC = std('Трансформатор (связанные обмотки)', [
  'X {n:1} {n:2} {n:3} {n:4} {model}',
  '.subckt {model} p1 p2 s1 s2',
  'R1 p1 a 1',
  'L1 a p2 {v:inductance}',
  'R2 s1 b 0.2',
  'L2 b s2 {e:inductance/(turnsRatio*turnsRatio)}',
  'K1 L1 L2 0.995',
  'Rdc s2 p2 100meg',
  '.ends',
], 'упрощённая модель: две связанные обмотки (k = 0,995), сопротивления 1 Ом и 0,2 Ом; без насыщения сердечника и потерь в стали');

/** Потенциометр: 1 и 3 — концы, 2 — движок; положение 0…100 % от вывода 1. */
export const POT = std('Потенциометр (делитель)', [
  'X {n:1} {n:2} {n:3} {model}',
  '.subckt {model} a w b',
  'R1 a w {e:resistance*position/100+0.1}',
  'R2 w b {e:resistance*(100-position)/100+0.1}',
  '.ends',
], 'идеальный делитель по положению движка (плюс 0,1 Ом контакта)');

/** Кварц: последовательный контур Lm–Cm–Rm параллельно C0 (Cm = 15 фФ, Rm = 30 Ом, C0 = 5 пФ). */
export const XTAL = std('Кварцевый резонатор (эквивалентная схема)', [
  'X {n:1} {n:2} {model}',
  '.subckt {model} a b',
  'C0 a b 5p',
  'Rm a m1 30',
  'Lm m1 m2 {e:1/(39.4784176*frequency*frequency*15e-15)}',
  'Cm m2 b 15f',
  '.ends',
], 'типовая эквивалентная схема кварца HC-49: Cm 15 фФ, Rm 30 Ом, C0 5 пФ; частота последовательного резонанса — параметр. Генераторы на кварце считаются медленно (высокая добротность)');

export const FUSE_1A = std('Предохранитель (сопротивление вставки)', [
  'R {n:1} {n:2} 0.1',
], 'сопротивление вставки 0,1 Ом; в расчёте вставка не перегорает — превышение тока показывается как перегрузка');

export const SWITCH_SPST = std('Кнопка / выключатель (замкнут или разомкнут)', [
  'R {n:1} {n:2} {e:1000000000-closed*999999999.95}',
], 'идеальный контакт: замкнут — 50 мОм, разомкнут — 1 ГОм; состояние — параметр «Замкнут (1/0)» на схеме');

/** Реле с параметрами на схеме: сопротивление катушки, напряжение срабатывания и отпускания.
 * Символ: 1 A1, 2 A2 (катушка), 3 COM, 4 NO, 5 NC. */
export const RELAY_PARAM = std('Реле (параметры катушки на схеме)', [
  'X {n:1} {n:2} {n:3} {n:4} {n:5} {model}',
  '.subckt {model} a1 a2 com no nc',
  'Vs a1 c1 0',
  'Rc c1 c2 {v:coilResistance}',
  'Lc c2 a2 0.05',
  'W1 com no Vs {model}_no',
  'W2 com nc Vs {model}_nc',
  '.model {model}_no CSW(IT={e:(pullIn+dropOut)/2/coilResistance} IH={e:(pullIn-dropOut)/2/coilResistance} RON=0.05 ROFF=1e9)',
  '.model {model}_nc CSW(IT={e:(pullIn+dropOut)/2/coilResistance} IH={e:(pullIn-dropOut)/2/coilResistance} RON=1e9 ROFF=0.05)',
  '.ends',
], 'поведенческая модель: катушка (сопротивление и индуктивность 50 мГн), срабатывание и отпускание по напряжению катушки; контакты 50 мОм');

/** Варистор с напряжением классификации на схеме (ток 1 мА), показатель нелинейности 30. */
export const VARISTOR_PARAM = std('Варистор (напряжение классификации на схеме)', [
  'X {n:1} {n:2} {model}',
  '.subckt {model} a b',
  'B1 a b I = 1m*sgn(V(a,b))*pow(abs(V(a,b))/{v:clampVoltage}, 30)',
  'C1 a b 0.5n',
  '.ends',
], 'степенная модель: 1 мА при напряжении классификации, показатель нелинейности 30');
