/**
 * SPICE-модели встроенного справочника (этап 4). Шаблоны — см. src/core/spice.ts.
 *
 * Происхождение параметров:
 *  • диоды и биполярные транзисторы — общеизвестные модели производителей (Diodes Inc., NXP, ON Semi,
 *    Fairchild), широко распространённые в учебных и бесплатных симуляторах;
 *  • стабилитроны, светодиод, MOSFET — упрощённые модели по ключевым параметрам даташита
 *    (напряжение стабилизации при тестовом токе, прямое напряжение, порог, сопротивление открытого
 *    канала, ёмкости);
 *  • NE555, LM358, L7805, LM317 — поведенческие модели по формулам даташита (пороги 1/3 и 2/3 питания,
 *    усиление и полоса, опорное напряжение и падение на регуляторе).
 * Все модели помечены «не проверены» (verified = false): они воспроизводят типовое поведение, а не
 * разброс и температурные зависимости конкретного экземпляра.
 */
import type { SimModel } from '../core/model';

type M = Omit<SimModel, 'id'>;
const m = (name: string, text: string[], source: string): M => ({ name, kind: text[0]!.startsWith('X') ? 'spice-subckt' : 'spice-primitive', text: text.join('\n'), source, verified: false });

// ---------- Диоды (символ: 1 — катод, 2 — анод) ----------

export const D_1N4007 = m('1N4007 (диод)', [
  'D {n:2} {n:1} {model}',
  '.model {model} D(IS=7.02767n RS=0.0341512 N=1.80803 EG=1.05743 XTI=5 BV=1000 IBV=5e-08 CJO=1e-11 VJ=0.7 M=0.5 FC=0.5 TT=1e-07)',
], 'модель Diodes Inc. 1N4007 (типовые параметры)');

export const D_1N4148 = m('1N4148 (диод)', [
  'D {n:2} {n:1} {model}',
  '.model {model} D(IS=2.52n RS=0.568 N=1.752 CJO=4p M=0.4 TT=20n BV=100 IBV=100n)',
], 'модель ON Semi 1N4148 (типовые параметры)');

export const D_1N5819 = m('1N5819 (диод Шоттки)', [
  'D {n:2} {n:1} {model}',
  '.model {model} D(IS=31.7u RS=0.051 N=1.373 CJO=110p M=0.35 EG=0.69 XTI=2 BV=40 IBV=1m)',
], 'модель Diodes Inc. 1N5819 (типовые параметры)');

export const D_1N4733A = m('1N4733A (стабилитрон 5,1 В)', [
  'D {n:2} {n:1} {model}',
  '.model {model} D(IS=1n RS=1 N=1 CJO=180p M=0.33 TT=50n BV=5.1 IBV=49m)',
], 'упрощённая модель по даташиту: 5,1 В при тестовом токе 49 мА');

export const D_BZX55C5V1 = m('BZX55C5V1 (стабилитрон 5,1 В)', [
  'D {n:2} {n:1} {model}',
  '.model {model} D(IS=1n RS=5 N=1 CJO=100p M=0.33 TT=50n BV=5.1 IBV=5m)',
], 'упрощённая модель по даташиту: 5,1 В при тестовом токе 5 мА');

export const D_LED_RED = m('Светодиод красный (обобщённая модель)', [
  'D {n:2} {n:1} {model}',
  '.model {model} D(IS=1e-18 N=2 RS=5 CJO=30p M=0.33 BV=5 IBV=10u)',
], 'обобщённая модель красного светодиода: около 2 В при 20 мА');

// ---------- Биполярные транзисторы (символ: 1 — база, 2 — коллектор, 3 — эмиттер) ----------

export const Q_BC547B = m('BC547B', [
  'Q {n:2} {n:1} {n:3} {model}',
  '.model {model} NPN(IS=2.39E-14 NF=1.008 ISE=3.545E-15 NE=1.541 BF=294.3 IKF=0.1357 VAF=63.2 NR=1.004 ISC=6.272E-14 NC=1.243 BR=7.946 IKR=0.1144',
  '+ VAR=25.9 RB=1 IRB=1.00E-06 RBM=1 RE=0.4683 RC=0.85 XTB=0 EG=1.11 XTI=3 CJE=1.358E-11 VJE=0.65 MJE=0.3279 TF=4.391E-10 XTF=120 VTF=2.643',
  '+ ITF=0.7495 PTF=0 CJC=3.728E-12 VJC=0.3997 MJC=0.2955 XCJC=0.6193 TR=1.00E-32 CJS=0 VJS=0.75 MJS=0.333 FC=0.9579)',
], 'модель NXP BC547B');

export const Q_BC557B = m('BC557B', [
  'Q {n:2} {n:1} {n:3} {model}',
  '.model {model} PNP(IS=3.83E-14 NF=1.008 ISE=1.22E-14 NE=1.528 BF=344.4 IKF=0.08039 VAF=21.11 NR=1.005 ISC=2.85E-13 NC=1.28 BR=14.84 IKR=0.047',
  '+ VAR=32.02 RB=1 IRB=1.00E-06 RBM=1 RE=0.6202 RC=0.5713 XTB=0 EG=1.11 XTI=3 CJE=1.23E-11 VJE=0.6106 MJE=0.378 TF=5.60E-10 XTF=3.414 VTF=5.23',
  '+ ITF=0.1483 PTF=0 CJC=1.08E-11 VJC=0.1022 MJC=0.3563 XCJC=0.6288 TR=1.00E-32 CJS=0 VJS=0.75 MJS=0.333 FC=0.8027)',
], 'модель NXP BC557B');

export const Q_2N3904 = m('2N3904', [
  'Q {n:2} {n:1} {n:3} {model}',
  '.model {model} NPN(IS=6.734f XTI=3 EG=1.11 VAF=74.03 BF=416.4 NE=1.259 ISE=6.734f IKF=66.78m XTB=1.5 BR=0.7371 NC=2 ISC=0 IKR=0 RC=1',
  '+ CJC=3.638p MJC=0.3085 VJC=0.75 FC=0.5 CJE=4.493p MJE=0.2593 VJE=0.75 TR=239.5n TF=301.2p ITF=0.4 VTF=4 XTF=2 RB=10)',
], 'модель Fairchild/ON 2N3904');

export const Q_2N3906 = m('2N3906', [
  'Q {n:2} {n:1} {n:3} {model}',
  '.model {model} PNP(IS=1.41f XTI=3 EG=1.11 VAF=18.7 BF=180.7 NE=1.5 ISE=0 IKF=80m XTB=1.5 BR=4.977 NC=2 ISC=0 IKR=0 RC=2.5',
  '+ CJC=9.728p MJC=0.5776 VJC=0.75 FC=0.5 CJE=8.063p MJE=0.3677 VJE=0.75 TR=33.42n TF=179.3p ITF=0.4 VTF=4 XTF=6 RB=10)',
], 'модель Fairchild/ON 2N3906');

// ---------- MOSFET (символ: 1 — затвор, 2 — сток, 3 — исток) ----------

function nmos(name: string, p: { vto: number; kp: number; cgs: string; cgd: string; cds: string; bv: number }, source: string): M {
  return m(name, [
    'X {n:2} {n:1} {n:3} {model}',
    '.subckt {model} d g s',
    `M1 d g s s {model}_m L=1u W=1u`,
    `.model {model}_m NMOS(LEVEL=1 VTO=${p.vto} KP=${p.kp} LAMBDA=0.002)`,
    'Dbody s d {model}_d',
    `.model {model}_d D(IS=2e-12 N=1 RS=0.01 CJO=${p.cds} M=0.5 TT=100n BV=${p.bv} IBV=250u)`,
    `Cgs g s ${p.cgs}`,
    `Cgd g d ${p.cgd}`,
    'Rleak g s 1e10',
    '.ends',
  ], source);
}

export const M_IRF540N = nmos('IRF540N (упрощённая)', { vto: 3, kp: 3.25, cgs: '1.92n', cgd: '40p', cds: '210p', bv: 110 },
  'упрощённая модель уровня 1 по даташиту: порог 3 В, Rси откр. 44 мОм при Uзи = 10 В, ёмкости Ciss/Crss, встроенный диод');
export const M_IRLZ44N = nmos('IRLZ44N (упрощённая)', { vto: 1.5, kp: 13, cgs: '1.55n', cgd: '150p', cds: '250p', bv: 60 },
  'упрощённая модель уровня 1 по даташиту: порог 1,5 В, Rси откр. 22 мОм при Uзи = 5 В, ёмкости, встроенный диод');
export const M_2N7000 = nmos('2N7000 (упрощённая)', { vto: 2.1, kp: 0.105, cgs: '16p', cgd: '4p', cds: '7p', bv: 65 },
  'упрощённая модель уровня 1 по даташиту: порог 2,1 В, Rси откр. ≈ 1,2 Ом при Uзи = 10 В, ёмкости, встроенный диод');

// ---------- Микросхемы (поведенческие модели) ----------

/** Один ОУ: усиление 100 дБ, полоса единичного усиления ≈ 1 МГц, скорость нарастания 0,3 В/мкс, выход от V− до V+ − 1,5 В. */
const OPAMP_358 = [
  '.subckt {model}_oa inp inm vcc vee out',
  'Rin inp inm 10meg',
  'Bg 0 n1 I = max(-47.7u, min(47.7u, 1m*V(inp,inm)))',
  'R1 n1 0 100meg',
  'C1 n1 0 159p',
  'Bhi nhi 0 V = V(vcc)-1.5',
  'Blo nlo 0 V = V(vee)+0.005',
  'Dh n1 nhi {model}_dl',
  'Dl nlo n1 {model}_dl',
  '.model {model}_dl D(IS=1e-15 N=0.05)',
  'E1 n2 0 n1 0 1',
  'Vs n2 n3 0',
  'Rout n3 out 1',
  'Bp vcc 0 I = max(i(Vs),0)',
  'Bn vee 0 I = min(i(Vs),0)',
  'Rq vcc vee 10k',
  '.ends',
];

export const IC_LM358 = m('LM358 (поведенческая)', [
  'X {n:3} {n:2} {n:1} {n:5} {n:6} {n:7} {n:8} {n:4} {model}',
  '.subckt {model} inpa inma outa inpb inmb outb vcc vee',
  'X1 inpa inma vcc vee outa {model}_oa',
  'X2 inpb inmb vcc vee outb {model}_oa',
  '.ends',
  ...OPAMP_358,
], 'поведенческая модель по даташиту: 100 дБ, 1 МГц, 0,3 В/мкс, выход до V+ − 1,5 В; без шумов, смещения нуля и ограничения тока');

export const IC_NE555 = m('NE555 (поведенческая)', [
  'X {n:1} {n:2} {n:3} {n:4} {n:5} {n:6} {n:7} {n:8} {model}',
  '.subckt {model} gnd trig out reset ctrl thres disch vcc',
  'R1 vcc ctrl 5k',
  'R2 ctrl nlow 5k',
  'R3 nlow gnd 5k',
  'Bh h 0 V = 0.5*(1+tanh((V(q)-0.5)/0.02))',
  'Bs s 0 V = 0.5*(1+tanh((V(nlow)-V(trig)+0.01*V(h))/0.001))',
  'Br r 0 V = 0.5*(1+tanh((V(thres)-V(ctrl)+0.01*(1-V(h)))/0.001))',
  'Brs rs 0 V = 0.5*(1+tanh((0.7-V(reset,gnd))/0.01))',
  'Bq 0 q I = 1e-2*((V(s)*(1-V(q)) - 10*(1-V(s))*V(r)*V(q) + (1-V(s))*(1-V(r))*(V(h)-V(q)))*(1-V(rs)) - 10*V(rs)*V(q))',
  'Cq q 0 10p',
  'Bo no 0 V = V(gnd) + V(h)*max(V(vcc,gnd)-1.7, 0) + (1-V(h))*0.1*min(V(vcc,gnd),1)',
  'Vs no no2 0',
  'Ro no2 out 2',
  'Bp vcc 0 I = max(i(Vs),0)',
  'Bn gnd 0 I = min(i(Vs),0)',
  'Bd disch gnd I = (1-V(h))*V(disch,gnd)/10',
  'Rsup vcc gnd 3k',
  '.ends',
], 'поведенческая модель по даташиту: пороги 1/3 и 2/3 питания (вывод CV), RS-триггер с приоритетом запуска и сброса, выход ≈ Uпит − 1,7 В, разряд ≈ 10 Ом');

export const IC_L7805 = m('L7805 (поведенческая)', [
  'X {n:1} {n:2} {n:3} {model}',
  '.subckt {model} in gnd out',
  'Bv nreg gnd V = min(5, max(V(in,gnd)-2, 0))',
  'Vs nreg n2 0',
  'Ro n2 out 0.01',
  'F1 in gnd Vs 1',
  'Bq in gnd I = 5m*min(1, max(0, V(in,gnd))/2)',
  '.ends',
], 'поведенческая модель по даташиту: 5 В, падение не менее 2 В, ток покоя 5 мА; без ограничения тока и тепловой защиты');

export const IC_LM317 = m('LM317 (поведенческая)', [
  'X {n:1} {n:2} {n:3} {model}',
  '.subckt {model} adj out in',
  'Bv nreg adj V = min(1.25, max(V(in,adj)-1.5, 0))',
  'Vs nreg n2 0',
  'Ro n2 out 0.01',
  'F1 in adj Vs 1',
  'Badj in adj I = 50u*min(1, max(0, V(in,adj))/1.5)',
  '.ends',
], 'поведенческая модель по даташиту: 1,25 В между OUT и ADJ, ток ADJ 50 мкА, падение не менее 1,5 В; без ограничения тока и тепловой защиты');

// ---------- Источники сигналов ----------

export const SRC_SINE: M = {
  name: 'Источник синусоидального напряжения', kind: 'spice-primitive', verified: true, source: 'ngspice: источник SIN; амплитуда — уровень сигнала и для частотного анализа',
  text: 'V {n:+} {n:-} DC {v:offset} AC {v:amplitude} SIN({v:offset} {v:amplitude} {v:frequency})',
};
export const SRC_PULSE: M = {
  name: 'Источник прямоугольных импульсов', kind: 'spice-primitive', verified: true, source: 'ngspice: источник PULSE; фронты — 1 % периода',
  text: 'V {n:+} {n:-} DC 0 PULSE(0 {v:voltage} 0 {e:0.01/frequency} {e:0.01/frequency} {e:duty/100/frequency-0.01/frequency} {e:1/frequency})',
};
export const SRC_CURRENT: M = {
  name: 'Источник постоянного тока', kind: 'spice-primitive', verified: true, source: 'ngspice: источник I (ток выходит из вывода «+»)',
  text: 'I {n:-} {n:+} DC {v:current}',
};

/** Электролитический конденсатор с ESR: идеальная ёмкость и последовательное сопротивление (этап 5). */
export const C_ELECTROLYTIC_ESR: M = {
  name: 'Конденсатор с ESR', kind: 'spice-subckt', verified: false,
  source: 'упрощённая модель: ёмкость и последовательное сопротивление (ESR), задаваемое на схеме; без ESL, утечки и частотной зависимости ESR',
  text: ['X {n:1} {n:2} {model}', '.subckt {model} a b', 'C1 a m {v:capacitance}', 'R1 m b {v:esr}', '.ends'].join('\n'),
};

/**
 * Лабораторный блок питания: стабилизация напряжения (CV) до достижения ограничения тока, затем
 * стабилизация тока (CC). Выходное сопротивление в режиме CV — 1 мОм; ток не может течь внутрь блока.
 * Выход выключается параметром «enabled» (0).
 */
export const SRC_LAB_PSU: M = {
  name: 'Лабораторный блок питания (CV/CC)', kind: 'spice-subckt', verified: true,
  source: 'идеализированная модель CV/CC: источник уставки с выходным сопротивлением 1 мОм; при достижении ограничения тока внутреннее сопротивление сверх предела — 1 МОм/А (стабилизация тока); ток внутрь блок не принимает; выключенный выход — 1 МОм',
  // Iвых = −I(Vs). Uвых = en·Uуст − 1 мОм·Iвых − 1e6·(r(Iвых − en·Iогр) − r(−Iвых)), r — гладкое max(0, x).
  // Кусочно-линейная форма с ненулевым наклоном везде — устойчивая сходимость (в отличие от насыщения тока).
  text: [
    'X {n:+} {n:-} {model}',
    '.subckt {model} p n',
    'Vs p x 0',
    'B1 x n V = {v:enabled}*{v:voltage} + 1e-3*I(Vs) - 1e6*(0.5*((-I(Vs) - {v:enabled}*{v:currentLimit}) + sqrt((-I(Vs) - {v:enabled}*{v:currentLimit})*(-I(Vs) - {v:enabled}*{v:currentLimit}) + 1e-24)) - 0.5*(I(Vs) + sqrt(I(Vs)*I(Vs) + 1e-24)))',
    '.ends',
  ].join('\n'),
};

// ---------- Этап 8: реле, трансформатор, потенциометр, кварц, оптопара, звук, датчики, защита ----------

/** Реле SRD-05VDC-SL-C: катушка 70 Ом / 0,1 Гн; срабатывает при токе ≥ 53,6 мА (3,75 В), отпускает ниже 7,1 мА (0,5 В).
 * Символ: 1 A1, 2 A2 (катушка), 3 COM, 4 NO, 5 NC. */
export const REL_SRD05 = m('Реле SRD-05VDC (поведенческая)', [
  'X {n:1} {n:2} {n:3} {n:4} {n:5} {model}',
  '.subckt {model} a1 a2 com no nc',
  'Vs a1 c1 0',
  'Rc c1 c2 70',
  'Lc c2 a2 0.1',
  'W1 com no Vs {model}_no',
  'W2 com nc Vs {model}_nc',
  '.model {model}_no CSW(IT=30.4m IH=23.2m RON=0.05 ROFF=1e9)',
  '.model {model}_nc CSW(IT=30.4m IH=23.2m RON=1e9 ROFF=0.05)',
  '.ends',
], 'поведенческая модель по даташиту Songle SRD-05VDC-SL-C: катушка 70 Ом, срабатывание 3,75 В, отпускание 0,5 В, контакты 50 мОм; без дребезга и времени срабатывания контактов');

/** Трансформатор: индуктивность первичной обмотки и коэффициент трансформации; связь 0,995. */
export const TR_GENERIC = m('Трансформатор (связанные обмотки)', [
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
export const POT = m('Потенциометр (делитель)', [
  'X {n:1} {n:2} {n:3} {model}',
  '.subckt {model} a w b',
  'R1 a w {e:resistance*position/100+0.1}',
  'R2 w b {e:resistance*(100-position)/100+0.1}',
  '.ends',
], 'идеальный делитель по положению движка (плюс 0,1 Ом контакта)');

/** Кварц: последовательный контур Lm–Cm–Rm параллельно C0 (Cm = 15 фФ, Rm = 30 Ом, C0 = 5 пФ). */
export const XTAL = m('Кварцевый резонатор (эквивалентная схема)', [
  'X {n:1} {n:2} {model}',
  '.subckt {model} a b',
  'C0 a b 5p',
  'Rm a m1 30',
  'Lm m1 m2 {e:1/(39.4784176*frequency*frequency*15e-15)}',
  'Cm m2 b 15f',
  '.ends',
], 'типовая эквивалентная схема кварца HC-49: Cm 15 фФ, Rm 30 Ом, C0 5 пФ; частота последовательного резонанса — параметр. Генераторы на кварце считаются медленно (высокая добротность)');

/** Оптопара PC817: 1 A, 2 K (светодиод), 3 E, 4 C (транзистор); коэффициент передачи тока 100 %. */
export const OPTO_PC817 = m('PC817 (поведенческая)', [
  'X {n:1} {n:2} {n:3} {n:4} {model}',
  '.subckt {model} a k e c',
  'D1 a x {model}_d',
  'Vs x k 0',
  'Bc c e I = 1.0*max(I(Vs),0)*(1-exp(-max(V(c,e),0)/0.1))',
  'Rl c e 1e9',
  '.model {model}_d D(IS=1.2e-13 N=1.8 RS=1 BV=6 IBV=10u)',
  '.ends',
], 'поведенческая модель: светодиод ≈ 1,2 В при 20 мА, коэффициент передачи тока 100 % (у PC817 — от 50 до 600 % по группам), насыщение ≈ 0,1 В; без быстродействия');

export const SPEAKER_8 = m('Динамик 8 Ом (сопротивление и индуктивность)', [
  'X {n:1} {n:2} {model}',
  '.subckt {model} a b',
  'R1 a m 8',
  'L1 m b 0.1m',
  '.ends',
], 'упрощённая модель звуковой катушки: 8 Ом и 0,1 мГн; без механического резонанса');

export const BUZZER_ACTIVE = m('Зуммер со встроенным генератором (нагрузка)', [
  'X {n:1} {n:2} {model}',
  '.subckt {model} p n',
  'D1 p x {model}_d',
  'R1 x n 150',
  '.model {model}_d D(IS=1e-14 N=1)',
  '.ends',
], 'модель нагрузки: около 30 мА при 5 В, ток только в прямом направлении (вывод 1 — «+»); звук не моделируется');

export const PIEZO = m('Пьезоизлучатель (ёмкость)', [
  'X {n:1} {n:2} {model}',
  '.subckt {model} a b',
  'C1 a b 20n',
  'R1 a b 10meg',
  '.ends',
], 'упрощённая модель: ёмкость 20 нФ; без механического резонанса');

export const NTC_10K = m('Терморезистор NTC 10 кОм, B = 3950', [
  'X {n:1} {n:2} {model}',
  '.subckt {model} a b',
  'B1 a b I = V(a,b)/(10000*exp(3950*(1/({v:temperature}+273.15)-1/298.15)))',
  '.ends',
], 'уравнение B-параметра: R = 10 кОм · exp(B · (1/T − 1/298,15 К)), B = 3950 К; температура — параметр на схеме');

export const LDR_GL5528 = m('Фоторезистор GL5528', [
  'X {n:1} {n:2} {model}',
  '.subckt {model} a b',
  'B1 a b I = V(a,b)/min(1e6, 1e4*pow(max({v:illuminance},0.01)/10, -0.7))',
  '.ends',
], 'упрощённая модель по даташиту: 10 кОм при 10 лк, показатель γ = 0,7, темновое сопротивление 1 МОм; без инерции');

export const VARISTOR_471 = m('Варистор 14D471K (поведенческая)', [
  'X {n:1} {n:2} {model}',
  '.subckt {model} a b',
  'B1 a b I = 1m*sgn(V(a,b))*pow(abs(V(a,b))/470, 30)',
  'C1 a b 0.5n',
  '.ends',
], 'степенная модель: 1 мА при 470 В, показатель нелинейности 30, ёмкость 0,5 нФ; без деградации и нагрева');

export const FUSE_1A = m('Предохранитель (сопротивление вставки)', [
  'R {n:1} {n:2} 0.1',
], 'сопротивление вставки 0,1 Ом; в расчёте вставка не перегорает — превышение тока показывается как перегрузка');

export const SWITCH_SPST = m('Кнопка / выключатель (замкнут или разомкнут)', [
  'R {n:1} {n:2} {e:1000000000-closed*999999999.95}',
], 'идеальный контакт: замкнут — 50 мОм, разомкнут — 1 ГОм; состояние — параметр «Замкнут (1/0)» на схеме');

/** Тиристор и симистор: защёлка по току управляющего электрода, удержание по току нагрузки, падение ≈ 1 В. */
const latch = (gate: string, main: string) => [
  'Vsm t m 0',
  'Vsg g gi 0',
  'Rgk gi k 50',
  'Bh h 0 V = 0.5*(1+tanh((V(q)-0.5)/0.02))',
  `Bset st 0 V = 0.5*(1+tanh((${gate}-10m)/1m))`,
  `Brst rs 0 V = 1-0.5*(1+tanh((${main}-20m)/2m))`,
  'Bq 0 q I = 1e-2*(10*V(st)*(1-V(q)) - (1-V(st))*V(rs)*V(q) + (1-V(st))*(1-V(rs))*(V(h)-V(q)))',
  'Cq q 0 10p',
  'Rq q 0 1e9',
];
export const SCR_BT151 = m('BT151 (поведенческая)', [
  'X {n:1} {n:2} {n:3} {model}',
  '.subckt {model} t k g',
  ...latch('I(Vsg)', 'I(Vsm)'),
  'D1 m n {model}_f',
  'Bm n k I = V(n,k)/(0.02 + (1-V(h))*1e7)',
  '.model {model}_f D(IS=1e-12 N=1.5 RS=0.01)',
  '.ends',
], 'поведенческая модель: открывается током управляющего электрода от 10 мА, держится при токе от 20 мА, падение ≈ 1 В; без dU/dt и времени выключения');
export const TRIAC_BT136 = m('BT136 (поведенческая)', [
  'X {n:1} {n:2} {n:3} {model}',
  '.subckt {model} k t g',
  ...latch('abs(I(Vsg))', 'abs(I(Vsm))'),
  'D1 m n {model}_f',
  'D2 n m {model}_f',
  'Bm n k I = V(n,k)/(0.02 + (1-V(h))*1e7)',
  '.model {model}_f D(IS=1e-12 N=1.5 RS=0.01)',
  '.ends',
], 'поведенческая модель: открывается током управляющего электрода любой полярности от 10 мА, держится при токе от 20 мА, падение ≈ 1 В; без dU/dt и квадрантов с разной чувствительностью');

/** Катушка с сопротивлением провода (поисковая катушка металлоискателя и т. п.). */
export const L_WITH_R = m('Катушка с сопротивлением провода', [
  'X {n:1} {n:2} {model}',
  '.subckt {model} a b',
  'R1 a m {v:resistance}',
  'L1 m b {v:inductance}',
  '.ends',
], 'индуктивность и последовательное сопротивление провода; без межвитковой ёмкости');

export const D_ZENER_GENERIC = m('Стабилитрон (напряжение — параметр)', [
  'D {n:2} {n:1} {model}',
  '.model {model} D(IS=1n RS=3 N=1 CJO=100p M=0.33 TT=50n BV={v:zenerVoltage} IBV=5m)',
], 'упрощённая модель: напряжение стабилизации при токе 5 мА задаётся на схеме');

// ---------- Логика КМОП (поведенческие модели) ----------

/** Порог — доля питания; out — выход через задержку RC и выходное сопротивление; ток выхода берётся из питания. */
function gateSubckt(name: string, kind: 'nand' | 'nor' | 'inv', schmitt: boolean, rout: number, delayC: string): string[] {
  const ins = kind === 'inv' ? ['a'] : ['a', 'b'];
  const sig = (x: string, th: string) => `0.5*(1+tanh((V(${x},vss)-${th}*V(vdd,vss))/(0.01*V(vdd,vss)+1e-3)))`;
  const lines = [`.subckt ${name} ${ins.join(' ')} y vdd vss`];
  if (!schmitt) {
    // «Все входы в 1» для И-НЕ, «хотя бы один в 1» для ИЛИ-НЕ
    const hi = kind === 'nor' ? `(1-(1-${sig('a', '0.5')})*(1-${sig('b', '0.5')}))` : ins.map((x) => sig(x, '0.5')).join('*');
    lines.push(`Bs s 0 V = ${hi}`, 'Bo no 0 V = V(vss) + V(vdd,vss)*(1-V(s))');
  } else {
    // Триггер Шмитта: переключение вверх при 0,59·Uпит, вниз при 0,39·Uпит
    const set = ins.map((x) => sig(x, '0.59')).join('*');
    const rst = `1-${ins.map((x) => sig(x, '0.39')).join('*')}`;
    lines.push(
      'Bh h 0 V = 0.5*(1+tanh((V(q)-0.5)/0.02))',
      `Bs s 0 V = ${set}`,
      `Br r 0 V = ${rst}`,
      'Bq 0 q I = 1e-2*(V(s)*(1-V(q)) - V(r)*V(q) + (1-V(s))*(1-V(r))*(V(h)-V(q)))',
      'Cq q 0 10p',
      'Bo no 0 V = V(vss) + V(vdd,vss)*(1-V(h))',
    );
  }
  lines.push('Rd no nd 1k', `Cd nd 0 ${delayC}`, 'Eo nb 0 nd 0 1', 'Vs nb n2 0', `Ro n2 y ${rout}`,
    'Bp vdd 0 I = max(I(Vs),0)', 'Bn vss 0 I = min(I(Vs),0)', ...ins.map((x) => `C${x} ${x} vss 5p`), '.ends');
  return lines;
}

/** Корпус на 14 выводов: gates — [входы…, выход] номерами выводов; питание 14, общий 7. */
function logic14(title: string, kind: 'nand' | 'nor' | 'inv', schmitt: boolean, hc: boolean, gates: string[][], source: string): M {
  const pins = Array.from({ length: 14 }, (_, i) => String(i + 1));
  return m(title, [
    `X ${pins.map((p) => `{n:${p}}`).join(' ')} {model}`,
    `.subckt {model} ${pins.map((p) => `p${p}`).join(' ')}`,
    ...gates.map((g, i) => `X${i + 1} ${g.map((p) => `p${p}`).join(' ')} p14 p7 {model}_g`),
    'Rq p14 p7 10meg',
    '.ends',
    ...gateSubckt('{model}_g', kind, schmitt, hc ? 50 : 1000, hc ? '8p' : '50p'),
  ], source);
}

const QUAD_2IN = [['1', '2', '3'], ['5', '6', '4'], ['8', '9', '10'], ['12', '13', '11']];
const HEX_INV = [['1', '2'], ['3', '4'], ['5', '6'], ['9', '8'], ['11', '10'], ['13', '12']];
const QUAD_HC = [['1', '2', '3'], ['4', '5', '6'], ['9', '10', '8'], ['12', '13', '11']];

export const IC_CD4011 = logic14('CD4011 (поведенческая)', 'nand', false, false, QUAD_2IN,
  'поведенческая модель КМОП 4000: порог 0,5 Uпит, выходное сопротивление 1 кОм, задержка ≈ 50 нс; питание 3…18 В');
export const IC_CD4001 = logic14('CD4001 (поведенческая)', 'nor', false, false, QUAD_2IN,
  'поведенческая модель КМОП 4000: порог 0,5 Uпит, выходное сопротивление 1 кОм, задержка ≈ 50 нс');
export const IC_CD4093 = logic14('CD4093 (поведенческая)', 'nand', true, false, QUAD_2IN,
  'поведенческая модель КМОП 4000 с триггером Шмитта: пороги 0,59 и 0,39 Uпит, выходное сопротивление 1 кОм');
export const IC_CD4069 = logic14('CD4069 (поведенческая)', 'inv', false, false, HEX_INV,
  'поведенческая модель КМОП 4000: шесть инверторов, порог 0,5 Uпит, выходное сопротивление 1 кОм');
export const IC_74HC00 = logic14('74HC00 (поведенческая)', 'nand', false, true, QUAD_HC,
  'поведенческая модель 74HC: порог 0,5 Uпит, выходное сопротивление 50 Ом, задержка ≈ 10 нс; питание 2…6 В');
export const IC_74HC14 = logic14('74HC14 (поведенческая)', 'inv', true, true, HEX_INV,
  'поведенческая модель 74HC с триггером Шмитта: пороги 0,59 и 0,39 Uпит, выходное сопротивление 50 Ом');

/** Сдвоенный компаратор LM393: открытый коллектор, ток стока до 16 мА. */
export const IC_LM393 = m('LM393 (поведенческая)', [
  'X {n:1} {n:2} {n:3} {n:4} {n:5} {n:6} {n:7} {n:8} {model}',
  '.subckt {model} outa inma inpa gnd inpb inmb outb vcc',
  'Ba outa gnd I = 16m*0.5*(1+tanh((V(inma)-V(inpa))/1m))*(1-exp(-max(V(outa,gnd),0)/0.08))',
  'Bb outb gnd I = 16m*0.5*(1+tanh((V(inmb)-V(inpb))/1m))*(1-exp(-max(V(outb,gnd),0)/0.08))',
  'Bq vcc gnd I = 0.4m*min(1,max(V(vcc,gnd),0)/2)',
  'Ra outa gnd 1e9',
  'Rb outb gnd 1e9',
  '.ends',
], 'поведенческая модель по даташиту: выход — открытый коллектор (нужен подтягивающий резистор), сток до 16 мА, ток потребления 0,4 мА; без задержки переключения');
