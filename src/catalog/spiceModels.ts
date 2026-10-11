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
