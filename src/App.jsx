import React, { useEffect, useMemo, useState } from "react";
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Legend
} from "recharts";

// ---------- INPS coefficiente di trasformazione (tabella semplificata) ----------
const COEFF_TABLE = {
  57: 4.586, 58: 4.664, 59: 4.746, 60: 4.833, 61: 4.926, 62: 5.025,
  63: 5.130, 64: 5.243, 65: 5.363, 66: 5.492, 67: 5.630, 68: 5.777,
  69: 5.936, 70: 6.106, 71: 6.289
};
function coeffTrasformazione(age) {
  const ages = Object.keys(COEFF_TABLE).map(Number).sort((a, b) => a - b);
  if (age <= ages[0]) return COEFF_TABLE[ages[0]];
  if (age >= ages[ages.length - 1]) return COEFF_TABLE[ages[ages.length - 1]];
  for (let i = 0; i < ages.length - 1; i++) {
    if (age >= ages[i] && age <= ages[i + 1]) {
      const t = (age - ages[i]) / (ages[i + 1] - ages[i]);
      return COEFF_TABLE[ages[i]] + t * (COEFF_TABLE[ages[i + 1]] - COEFF_TABLE[ages[i]]);
    }
  }
  return 5.6;
}
function annuityFactor(years, rate) {
  if (years <= 0) return 1;
  if (rate <= 0) return years;
  return (1 - Math.pow(1 + rate, -years)) / rate;
}

// IRPEF 2024/2026 a scaglioni + detrazione da pensione (formula ufficiale semplificata) + addizionali locali
function irpefLorda(reddito) {
  if (reddito <= 28000) return reddito * 0.23;
  if (reddito <= 50000) return 28000 * 0.23 + (reddito - 28000) * 0.33;
  return 28000 * 0.23 + 22000 * 0.33 + (reddito - 50000) * 0.43;
}
function detrazionePensione(reddito) {
  if (reddito <= 0) return 0;
  if (reddito <= 8500) return Math.min(1955, irpefLorda(reddito));
  if (reddito <= 28000) return 700 + 1255 * (28000 - reddito) / 19500;
  if (reddito <= 50000) return 700 * (50000 - reddito) / 22000;
  return 0;
}
function nettoPensioneInps(lordo, addizionaliPct) {
  if (lordo <= 0) return 0;
  const irpefNetta = Math.max(0, irpefLorda(lordo) - detrazionePensione(lordo));
  const addizionali = lordo * (addizionaliPct / 100);
  return Math.max(0, lordo - irpefNetta - addizionali);
}
const fmt = (n) => Math.round(n).toLocaleString("it-IT");

// Percentuale azionaria target per una data età (glide path lineare)
function equityPctForAge(age, p) {
  const glideStartAge = p.retireAge - p.glideYears;
  if (age <= glideStartAge) return p.equityPctStart;
  if (age >= p.retireAge) return p.equityPctRetirement;
  const t = (age - glideStartAge) / (p.retireAge - glideStartAge);
  return p.equityPctStart + t * (p.equityPctRetirement - p.equityPctStart);
}

function useSimulation(p) {
  return useMemo(() => {
    const rows = [];
    // due riserve separate: ognuna compone al proprio rendimento
    let eqBal = p.portfolioStart * (p.equityPctStart / 100);
    let eqBasis = eqBal;
    let boBal = p.portfolioStart * (1 - p.equityPctStart / 100);
    let boBasis = boBal;
    let fondoBal = p.fondoPensioneAttivo ? (p.fondoSaldoIniziale || 0) : 0;
    let inpsMontante = p.inpsMontanteIniziale || 0;
    let renditaFondoNetta = null;
    let renditaLordaFondo = null;
    let inpsNetta = null;
    let inpsLordaFinale = null;
    let anticipata64Lorda = null;
    let depletionAge = null;
    let bufferBreachAge = null;
    let capitaleVersato = p.portfolioStart; // solo il capitale messo di tasca propria, senza contare alcun rendimento

    const fondoContribYears = p.renditaAge - Math.min(p.fondoStartAge, p.currentAge);
    const aliquotaRendita = Math.max(9, 15 - 0.3 * Math.max(0, fondoContribYears - 15)) / 100;

    // preleva proporzionalmente dai due asset in base al peso attuale, tassando solo la plusvalenza di ciascuno
    const withdraw = (amount) => {
      const totalBal = eqBal + boBal;
      if (amount <= 0 || totalBal <= 0) return;
      const wEq = eqBal / totalBal, wBo = boBal / totalBal;
      const gainEq = eqBal > 0 ? Math.max(0, (eqBal - eqBasis) / eqBal) : 0;
      const gainBo = boBal > 0 ? Math.max(0, (boBal - boBasis) / boBal) : 0;
      const blendedTax = wEq * gainEq * (p.taxEquity / 100) + wBo * gainBo * (p.taxBond / 100);
      const gross = amount / Math.max(0.01, 1 - blendedTax);
      const wdEq = gross * wEq, wdBo = gross * wBo;
      eqBasis -= eqBasis * (wdEq / Math.max(eqBal, 0.0001));
      boBasis -= boBasis * (wdBo / Math.max(boBal, 0.0001));
      eqBal -= wdEq; boBal -= wdBo;
    };

    // vende dall'asset in eccesso (tassando la plusvalenza) per riportare il mix al target: ribilancio con attrito fiscale
    const rebalance = (targetPct) => {
      const totalBal = eqBal + boBal;
      if (totalBal <= 0) return;
      const targetEq = totalBal * targetPct;
      const diff = eqBal - targetEq; // >0: azioni in eccesso, <0: obbligaz./oro in eccesso
      if (Math.abs(diff) < 1) return;
      if (diff > 0) {
        const gainFrac = eqBal > 0 ? Math.max(0, (eqBal - eqBasis) / eqBal) : 0;
        const tax = diff * gainFrac * (p.taxEquity / 100);
        eqBasis -= eqBasis * (diff / Math.max(eqBal, 0.0001));
        eqBal -= diff;
        const net = diff - tax;
        boBal += net; boBasis += net;
      } else {
        const sell = -diff;
        const gainFrac = boBal > 0 ? Math.max(0, (boBal - boBasis) / boBal) : 0;
        const tax = sell * gainFrac * (p.taxBond / 100);
        boBasis -= boBasis * (sell / Math.max(boBal, 0.0001));
        boBal -= sell;
        const net = sell - tax;
        eqBal += net; eqBasis += net;
      }
    };

    for (let age = p.currentAge; age <= p.lifeExpectancy; age++) {
      const working = age < p.retireAge;
      const bridgePhase = !working && age < p.renditaAge;
      const fondoPhase = !working && age >= p.renditaAge && age < p.pensionAge;
      const pensionPhase = age >= p.pensionAge;
      const targetPct = equityPctForAge(age, p) / 100;
      const yearsElapsed = age - p.currentAge;
      const ralOggi = p.ral * Math.pow(1 + p.ralGrowthPct / 100, yearsElapsed);
      const speseBase = p.speseVive * Math.pow(1 + p.speseGrowthPct / 100, yearsElapsed);
      const intervalliAttivi = (p.speseIntervalli || []).filter((s) => age >= s.startAge && age <= s.endAge);
      const incrementoIntervalli = intervalliAttivi.reduce(
        (sum, s) => sum + (s.type === "pct" ? p.speseVive * ((s.value || 0) / 100) : (s.value || 0)), 0
      );
      const speseOggi = speseBase + incrementoIntervalli;
      const riduzionePacIntervalli = intervalliAttivi.reduce((sum, s) => {
        if (!s.linkPac) return sum;
        const incr = s.type === "pct" ? p.speseVive * ((s.value || 0) / 100) : (s.value || 0);
        return sum + incr * ((s.reduzionePct ?? 100) / 100);
      }, 0);

      // --- fotografia dello stato all'età ESATTA, prima di qualunque versamento/prelievo/rendimento dell'anno ---
      const totalPortfolioSnap = eqBal + boBal;
      if (depletionAge === null && totalPortfolioSnap <= 0 && age > p.retireAge) depletionAge = age;
      if (bufferBreachAge === null && totalPortfolioSnap < p.cuscinetto && age > p.retireAge) bufferBreachAge = age;
      const entrateCorrenti = (age >= p.pensionAge ? (inpsNetta || 0) : 0) + (age >= p.renditaAge ? (renditaFondoNetta || 0) : 0);
      const surplus = entrateCorrenti > speseOggi;
      const spesaExtraAnno = (p.speseExtra || []).filter((s) => s.age === age).reduce((sum, s) => sum + (s.amount || 0), 0);

      rows.push({
        age,
        equity: Math.round(eqBal),
        bond: Math.round(boBal),
        totale: Math.round(totalPortfolioSnap),
        fondo: Math.round(fondoBal),
        montanteInps: Math.round(age <= p.pensionAge ? inpsMontante : 0),
        capitaleVersato: Math.round(capitaleVersato),
        speseAnnue: Math.round(speseOggi),
        equityPct: totalPortfolioSnap > 0 ? Math.round((eqBal / totalPortfolioSnap) * 100) : 0,
        surplus,
        spesaExtra: spesaExtraAnno,
        fase: working ? "attiva" : bridgePhase ? "ponte" : fondoPhase ? "fondo" : "pensione"
      });

      // --- da qui in poi: attività dell'anno vissuto a questa età, che portano allo stato dell'età successiva ---

      // --- Fase attiva: versamenti già indirizzati verso il mix target del momento ---
      if (working) {
        const contribEffettivo = Math.max(0, p.annualContrib - riduzionePacIntervalli);
        eqBal += contribEffettivo * targetPct; eqBasis += contribEffettivo * targetPct;
        boBal += contribEffettivo * (1 - targetPct); boBasis += contribEffettivo * (1 - targetPct);
        capitaleVersato += contribEffettivo;

        if (p.fondoPensioneAttivo) {
          const tfr = ralOggi * (p.tfrPct / 100);
          const contribAzienda = ralOggi * (p.datorePct / 100);
          const contribLavoratore = ralOggi * (p.dipendentePct / 100);
          const bonusProduzione = ralOggi * (p.bonusProduzionePct / 100);
          fondoBal += tfr + contribAzienda + contribLavoratore + bonusProduzione;
        }

        inpsMontante += ralOggi * (p.inpsAliquota / 100);
      }

      // --- Fase ponte: eventuale versamento extra al fondo pensione + prelievo spese ---
      if (bridgePhase) {
        const extraFondo = p.fondoPensioneAttivo ? p.contribFondoPostLavoro : 0;
        withdraw(speseOggi + extraFondo);
        if (p.fondoPensioneAttivo) fondoBal += p.contribFondoPostLavoro;
      }

      // --- Da renditaAge: il fondo pensione inizia a erogare la rendita ---
      if (p.fondoPensioneAttivo && age === p.renditaAge) {
        const years = Math.max(1, p.lifeExpectancy - p.renditaAge);
        const factor = annuityFactor(years, p.fondoReturn / 100);
        renditaLordaFondo = fondoBal / factor;
        renditaFondoNetta = renditaLordaFondo * (1 - aliquotaRendita);
      }
      // --- decumulo del fondo: la rendita viene erogata ogni anno finché c'è residuo ---
      if (renditaLordaFondo && fondoBal > 0) {
        fondoBal = Math.max(0, fondoBal - renditaLordaFondo);
      }

      // --- Fase fondo pensione attivo, INPS non ancora ---
      if (fondoPhase) {
        withdraw(Math.max(0, speseOggi - (renditaFondoNetta || 0)));
      }

      // --- Da pensionAge: arriva anche l'INPS ---
      if (age === 64 && anticipata64Lorda === null) {
        anticipata64Lorda = inpsMontante * (coeffTrasformazione(64) / 100);
      }
      if (age === p.pensionAge) {
        const coeff = coeffTrasformazione(age) / 100;
        const inpsLorda = inpsMontante * coeff;
        inpsLordaFinale = inpsLorda;
        inpsNetta = nettoPensioneInps(inpsLorda, p.addizionaliPct);
      }
      if (pensionPhase) {
        const entrate = (inpsNetta || 0) + (renditaFondoNetta || 0);
        withdraw(Math.max(0, speseOggi - entrate));
      }

      // --- spese straordinarie una tantum (auto, ristrutturazione, ecc.), prelevate dal portafoglio in proporzione al mix corrente ---
      if (spesaExtraAnno > 0) withdraw(spesaExtraAnno);

      // --- crescita annua: ogni asset compone al proprio rendimento ---
      if (eqBal > 0) eqBal *= 1 + p.equityReturn / 100;
      if (boBal > 0) boBal *= 1 + p.bondReturn / 100;
      if (fondoBal > 0) fondoBal *= 1 + p.fondoReturn / 100;
      if (age < p.pensionAge) inpsMontante *= 1 + p.inpsRivalutazione / 100;

      eqBal = Math.max(eqBal, 0);
      boBal = Math.max(boBal, 0);

      // --- ribilanciamento annuo verso il mix target, con tassazione sulla vendita ---
      rebalance(targetPct);
      eqBal = Math.max(eqBal, 0);
      boBal = Math.max(boBal, 0);
    }

    const surplusAge = rows.find((r) => r.surplus)?.age ?? null;

    const ASSEGNO_SOCIALE_ANNUO_2026 = 7101;
    const SOGLIA_ANTICIPATA_64_ANNUA_2026 = 20842;
    const okVecchiaia = inpsLordaFinale !== null && inpsLordaFinale >= ASSEGNO_SOCIALE_ANNUO_2026;
    const okAnticipata64 = anticipata64Lorda !== null && anticipata64Lorda >= SOGLIA_ANTICIPATA_64_ANNUA_2026;

    return {
      rows, depletionAge, bufferBreachAge, renditaFondoNetta, renditaLordaFondo, inpsNetta, aliquotaRendita, surplusAge,
      inpsLordaFinale, anticipata64Lorda, okVecchiaia, okAnticipata64,
      ASSEGNO_SOCIALE_ANNUO_2026, SOGLIA_ANTICIPATA_64_ANNUA_2026
    };
  }, [p]);
}

function StackedRefLabel({ viewBox, value, fill, yOffset }) {
  const x = viewBox?.x ?? 0;
  const width = Math.max(60, value.length * 6.2);
  return (
    <g>
      <rect x={x - width / 2} y={yOffset} width={width} height={14} fill="#F5F3EEEE" />
      <text x={x} y={yOffset + 10} textAnchor="middle" fontSize={10} fontFamily="Helvetica Neue, Arial, sans-serif" fill={fill} fontWeight={600}>
        {value}
      </text>
    </g>
  );
}

function NumberField({ label, value, onChange, step = 1, suffix = "" }) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    // se il valore esterno cambia per motivi diversi da quanto sto digitando, risincronizzo
    if (parseFloat(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handleChange = (e) => {
    const v = e.target.value;
    setText(v); // permette la casella vuota mentre si digita, senza forzare 0
    if (v === "" || v === "-") return;
    const num = parseFloat(v);
    if (!isNaN(num)) onChange(num);
  };

  const handleBlur = () => {
    if (text === "" || isNaN(parseFloat(text))) setText(String(value)); // torna all'ultimo valore valido se lasci vuoto
  };

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <div className="field-input">
        <input type="number" value={text} step={step} onChange={handleChange} onBlur={handleBlur} />
        {suffix && <span className="suffix">{suffix}</span>}
      </div>
    </label>
  );
}

const STORAGE_KEY = "simulazione-pensione-v1";
const DEFAULT_PARAMS = {
    currentAge: 26,
    retireAge: 48,
    renditaAge: 68,
    pensionAge: 68,
    lifeExpectancy: 90,
    portfolioStart: 0,
    equityPctStart: 75,
    annualContrib: 3600,
    equityReturn: 5,
    bondReturn: 1,
    glideYears: 5,
    equityPctRetirement: 50,
    ral: 30000,
    ralGrowthPct: 0,
    tfrPct: 6.9,
    datorePct: 1.55,
    dipendentePct: 2,
    bonusProduzionePct: 5,
    fondoPensioneAttivo: true,
    fondoReturn: 2,
    fondoStartAge: 26,
    fondoSaldoIniziale: 0,
    contribFondoPostLavoro: 0,
    speseVive: 12000,
    speseGrowthPct: 0,
    cuscinetto: 10000,
    taxEquity: 26,
    taxBond: 20,
    inpsAliquota: 33,
    inpsMontanteIniziale: 0,
    inpsRivalutazione: 1,
    addizionaliPct: 2,
    speseExtra: [],
    speseIntervalli: [
      { id: 1, startAge: 32, endAge: 50, type: "abs", value: 4000, label: "Intervallo 1", linkPac: true, reduzionePct: 100 },
      { id: 2, startAge: 51, endAge: 60, type: "abs", value: 4000, label: "Intervallo 2", linkPac: true, reduzionePct: 100 },
    ],
};

function loadInitialParams() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return { ...DEFAULT_PARAMS, ...JSON.parse(saved) };
  } catch (e) {
    // localStorage non disponibile o JSON corrotto: si riparte dai default, senza errori bloccanti
  }
  return DEFAULT_PARAMS;
}

export default function App() {
  const [p, setP] = useState(loadInitialParams);
  const [importError, setImportError] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    } catch (e) {
      // storage pieno o non disponibile: si continua comunque, solo senza salvataggio automatico
    }
  }, [p]);

  const esportaJson = () => {
    const blob = new Blob([JSON.stringify(p, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `simulazione-pensione-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importaJson = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        setP({ ...DEFAULT_PARAMS, ...parsed });
        setImportError("");
      } catch (err) {
        setImportError("File non valido: assicurati di aver selezionato un JSON esportato da questo simulatore.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const resetDefault = () => {
    if (window.confirm("Ripristinare tutti i valori di default? Le modifiche attuali andranno perse (a meno di averle esportate).")) {
      setP(DEFAULT_PARAMS);
    }
  };

  const set = (k) => (v) => setP((prev) => ({ ...prev, [k]: v }));
  const addSpesaExtra = () => setP((prev) => ({
    ...prev,
    speseExtra: [...(prev.speseExtra || []), { id: Date.now(), age: prev.retireAge, amount: 20000, label: "Spesa" }]
  }));
  const updateSpesaExtra = (id, field, value) => setP((prev) => ({
    ...prev,
    speseExtra: prev.speseExtra.map((s) => (s.id === id ? { ...s, [field]: value } : s))
  }));
  const removeSpesaExtra = (id) => setP((prev) => ({
    ...prev,
    speseExtra: prev.speseExtra.filter((s) => s.id !== id)
  }));
  const addSpesaIntervallo = () => setP((prev) => ({
    ...prev,
    speseIntervalli: [...(prev.speseIntervalli || []), { id: Date.now(), startAge: prev.currentAge, endAge: prev.currentAge + 17, type: "abs", value: 2000, label: "Figlio", linkPac: false, reduzionePct: 100 }]
  }));
  const updateSpesaIntervallo = (id, field, value) => setP((prev) => ({
    ...prev,
    speseIntervalli: prev.speseIntervalli.map((s) => (s.id === id ? { ...s, [field]: value } : s))
  }));
  const removeSpesaIntervallo = (id) => setP((prev) => ({
    ...prev,
    speseIntervalli: prev.speseIntervalli.filter((s) => s.id !== id)
  }));

  const sim = useSimulation(p);
  const sostenibile = (sim.bufferBreachAge === null || sim.bufferBreachAge >= p.lifeExpectancy)
    && (sim.depletionAge === null || sim.depletionAge >= p.lifeExpectancy);
  const glideStartAge = p.retireAge - p.glideYears;

  return (
    <div className="wrap">
      <style>{`
        * { box-sizing: border-box; }
        .wrap {
          font-family: 'Iowan Old Style','Georgia',serif;
          background: #F5F3EE;
          color: #1D2B28;
          min-height: 100vh;
          padding: 28px 20px 60px;
        }
        h1 { font-size: 26px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 4px; }
        .sub { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 13px; color: #5C6B67; margin: 0 0 24px; }
        .verdict {
          font-family: 'Helvetica Neue', Arial, sans-serif;
          display: flex; align-items: baseline; gap: 10px;
          padding: 18px 20px; border-radius: 4px; margin-bottom: 22px;
          background: ${sostenibile ? "#12332C" : "#3B1F1A"};
          color: #F5F3EE;
        }
        .verdict .big { font-size: 28px; font-weight: 700; font-family: 'Iowan Old Style',Georgia,serif; }
        .verdict .label { font-size: 12px; opacity: 0.75; text-transform: uppercase; letter-spacing: 0.06em; }
        .cards {
          font-family: 'Helvetica Neue', Arial, sans-serif;
          display: grid; grid-template-columns: repeat(auto-fit,minmax(140px,1fr));
          gap: 10px; margin-bottom: 22px;
        }
        .card { background: #FFFFFF; border: 1px solid #E4DFD3; border-radius: 4px; padding: 12px 14px; }
        .card .k { font-size: 11px; color: #8A8578; text-transform: uppercase; letter-spacing: 0.05em; }
        .card .v { font-size: 19px; font-weight: 700; color: #12332C; margin-top: 3px; font-variant-numeric: tabular-nums; }
        .chart-box { background: #FFFFFF; border: 1px solid #E4DFD3; border-radius: 4px; padding: 14px 6px 6px; margin-bottom: 26px; }
        .chart-title { font-family:'Helvetica Neue',Arial,sans-serif; font-size:13px; padding: 0 14px 8px; color:#5C6B67; }
        details { background: #FFFFFF; border: 1px solid #E4DFD3; border-radius: 4px; margin-bottom: 10px; }
        summary {
          font-family: 'Helvetica Neue', Arial, sans-serif;
          cursor: pointer; padding: 12px 16px; font-size: 13px; font-weight: 600;
          color: #12332C; letter-spacing: 0.02em;
        }
        .group { padding: 4px 16px 16px; display: grid; grid-template-columns: repeat(auto-fill,minmax(150px,1fr)); gap: 10px 14px; }
        .field { font-family:'Helvetica Neue',Arial,sans-serif; display:flex; flex-direction:column; gap:4px; }
        .field-label { font-size: 11.5px; color: #5C6B67; }
        .field-input { display:flex; align-items:center; border:1px solid #D9D3C4; border-radius:3px; background:#FBFAF6; }
        .field-input input {
          border: none; background: transparent; padding: 7px 8px; width: 100%;
          font-size: 13.5px; font-variant-numeric: tabular-nums; color:#1D2B28; outline:none;
        }
        .field-input .suffix { padding-right: 8px; font-size: 12px; color:#8A8578; }
        .note {
          font-family: 'Helvetica Neue', Arial, sans-serif;
          font-size: 12px; color: #6B655A; background: #EFE9DA; border-left: 3px solid #B8862B;
          padding: 10px 14px; border-radius: 2px; margin-top: 4px; line-height: 1.5;
        }
      `}</style>

      <h1>Simulazione pensione anticipata</h1>
      <p className="sub">Rendimenti reali (al netto inflazione) · valori in potere d'acquisto di oggi · portafoglio a ribilanciamento automatico</p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18, fontFamily: "Helvetica Neue, Arial, sans-serif" }}>
        <button onClick={esportaJson} style={{ border: "1px solid #12332C", background: "#12332C", color: "#F5F3EE", borderRadius: 3, padding: "7px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
          ⬇ Esporta JSON
        </button>
        <label style={{ border: "1px solid #12332C", background: "#F5F3EE", color: "#12332C", borderRadius: 3, padding: "7px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
          ⬆ Importa JSON
          <input type="file" accept="application/json" onChange={importaJson} style={{ display: "none" }} />
        </label>
        <button onClick={resetDefault} style={{ border: "1px solid #D9D3C4", background: "#FBFAF6", color: "#8B3A2B", borderRadius: 3, padding: "7px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
          ↺ Ripristina default
        </button>
      </div>
      {importError && <div className="note" style={{ borderLeftColor: "#8B3A2B", color: "#8B3A2B" }}>{importError}</div>}

      <div className="verdict">
        <div>
          <div className="label">{sostenibile ? "Strategia sostenibile (cuscinetto mai intaccato)" : "Guardrail violato"}</div>
          <div className="big">
            {sim.depletionAge
              ? `Capitale a zero a ${sim.depletionAge} anni`
              : sim.bufferBreachAge
              ? `Cuscinetto di ${fmt(p.cuscinetto)} € sceso sotto soglia a ${sim.bufferBreachAge} anni`
              : `Cuscinetto di ${fmt(p.cuscinetto)} € sempre mantenuto fino a ${p.lifeExpectancy} anni`}
          </div>
        </div>
      </div>

      <div className="cards">
        <div className="card">
          <div className="k">Mensilità totale (fondo + INPS), 12 mensilità — potere d'acquisto di oggi</div>
          <div className="v">
            {sim.inpsLordaFinale || sim.renditaLordaFondo
              ? `${fmt(((sim.inpsLordaFinale || 0) + (sim.renditaLordaFondo || 0)) / 12)} € lorda / ${fmt(((sim.inpsNetta || 0) + (sim.renditaFondoNetta || 0)) / 12)} € netta`
              : "—"}
          </div>
        </div>
        <div className="card"><div className="k">Rendita fondo pens. lorda / netta</div><div className="v">{sim.renditaLordaFondo ? `${fmt(sim.renditaLordaFondo)} / ${fmt(sim.renditaFondoNetta)} €` : "—"}</div></div>
        <div className="card"><div className="k">Pensione INPS lorda / netta</div><div className="v">{sim.inpsLordaFinale ? `${fmt(sim.inpsLordaFinale)} / ${fmt(sim.inpsNetta)} €` : "—"}</div></div>
        <div className="card"><div className="k">Anni di decumulo puro</div><div className="v">{p.renditaAge - p.retireAge}</div></div>
        <div className="card"><div className="k">Pensione ≥ spese da</div><div className="v">{sim.surplusAge ? `${sim.surplusAge} anni` : "mai"}</div></div>
        <div className="card" style={{ borderColor: sostenibile ? "#12332C" : "#8B3A2B" }}>
          <div className="k">Cuscinetto ({fmt(p.cuscinetto)} €)</div>
          <div className="v" style={{ color: sostenibile ? "#12332C" : "#8B3A2B" }}>
            {sim.bufferBreachAge ? `violato a ${sim.bufferBreachAge} anni` : "mai violato ✓"}
          </div>
        </div>
      </div>

      <div className="chart-box">
        <div className="chart-title">Portafoglio personale (mix dinamico azioni/obblig.-oro) nel tempo — la linea grigia punteggiata è quanto hai versato di tasca tua, senza rendimenti: la distanza dalla curva colorata è l'effetto della composizione</div>
        <ResponsiveContainer width="100%" height={420}>
          <ComposedChart data={sim.rows} margin={{ top: 92, right: 18, left: 0, bottom: 4 }}>
            <CartesianGrid stroke="#EAE5D8" />
            <XAxis dataKey="age" tick={{ fontSize: 11, fontFamily: "Helvetica Neue" }} />
            <YAxis yAxisId="left" tick={{ fontSize: 11, fontFamily: "Helvetica Neue" }} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fontFamily: "Helvetica Neue", fill: "#8A5A00" }} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
            <Tooltip
              formatter={(v, name) => [`${fmt(v)} €`, name]}
              labelFormatter={(a) => `Età ${a}`}
              contentStyle={{ fontSize: 11, fontFamily: "Helvetica Neue, Arial, sans-serif", maxWidth: 220 }}
              itemStyle={{ fontSize: 11, whiteSpace: "normal", lineHeight: 1.3 }}
              labelStyle={{ fontSize: 11.5, fontWeight: 600 }}
            />
            <Legend verticalAlign="bottom" wrapperStyle={{ fontSize: 10.5, fontFamily: "Helvetica Neue", paddingTop: 8, lineHeight: 1.6 }} iconSize={9} />
            <Area yAxisId="left" type="monotone" dataKey="equity" name="Quota azionaria" stackId="1" fill="#12332CB0" stroke="#12332C" strokeWidth={1.5} />
            <Area yAxisId="left" type="monotone" dataKey="bond" name="Quota obblig./oro" stackId="1" fill="#B8862B55" stroke="#B8862B" strokeWidth={1.5} />
            <Line yAxisId="left" type="monotone" dataKey="fondo" name="Fondo pensione (accumulo)" stroke="#7A3B2E" strokeWidth={2} dot={false} />
            <Line yAxisId="left" type="monotone" dataKey="montanteInps" name="Montante contributivo INPS" stroke="#3B5A8A" strokeWidth={2} strokeDasharray="4 2" dot={false} />
            <Line yAxisId="left" type="monotone" dataKey="capitaleVersato" name="Capitale versato (senza rendimenti)" stroke="#6B655A" strokeWidth={1.5} strokeDasharray="1 3" dot={false} />
            <Line yAxisId="right" type="monotone" dataKey="speseAnnue" name="Spese vive annue (asse destro)" stroke="#8A5A00" strokeWidth={1.5} strokeDasharray="6 2" dot={false} />
            <ReferenceLine yAxisId="left" x={p.retireAge} stroke="#8A8578" strokeDasharray="3 3"
              label={<StackedRefLabel value="Stop lavoro" fill="#5C6B67" yOffset={4} />} />
            <ReferenceLine yAxisId="left" x={p.renditaAge} stroke="#8A8578" strokeDasharray="3 3"
              label={<StackedRefLabel value="Rendita fondo" fill="#5C6B67" yOffset={22} />} />
            <ReferenceLine yAxisId="left" x={p.pensionAge} stroke="#8A8578" strokeDasharray="3 3"
              label={<StackedRefLabel value="INPS" fill="#5C6B67" yOffset={40} />} />
            <ReferenceLine yAxisId="left" y={p.cuscinetto} stroke="#8B3A2B" strokeDasharray="5 3" strokeWidth={1.5}
              label={{ value: `Cuscinetto ${fmt(p.cuscinetto)} €`, fontSize: 10, fill: "#8B3A2B", position: "insideBottomLeft" }} />
            {(p.speseExtra || []).map((s, i) => (
              <ReferenceLine yAxisId="left" key={s.id} x={s.age} stroke="#B8862B" strokeWidth={1.5} strokeDasharray="2 3"
                label={<StackedRefLabel value={s.label || "Spesa"} fill="#8A5A00" yOffset={56 + (i % 2) * 18} />} />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <details open>
        <summary>Fase attiva (accumulo)</summary>
        <div className="group">
          <NumberField label="Età attuale" value={p.currentAge} onChange={set("currentAge")} />
          <NumberField label="Età stop lavoro" value={p.retireAge} onChange={set("retireAge")} />
          <NumberField label="Portafoglio iniziale totale" value={p.portfolioStart} onChange={set("portfolioStart")} suffix="€" />
          <NumberField label="PAC totale annuo" value={p.annualContrib} onChange={set("annualContrib")} suffix="€" />
          <NumberField label="Rendimento reale azioni" value={p.equityReturn} onChange={set("equityReturn")} step={0.1} suffix="%" />
          <NumberField label="Rendimento reale obblig./oro" value={p.bondReturn} onChange={set("bondReturn")} step={0.1} suffix="%" />
        </div>
      </details>

      <details open>
        <summary>Asset allocation dinamica</summary>
        <div className="group">
          <NumberField label="% azionario in accumulo" value={p.equityPctStart} onChange={set("equityPctStart")} suffix="%" />
          <NumberField label="% azionario a fine carriera" value={p.equityPctRetirement} onChange={set("equityPctRetirement")} suffix="%" />
          <NumberField label="Anni prima dello stop per iniziare il ribilancio" value={p.glideYears} onChange={set("glideYears")} />
        </div>
        <div className="note">
          Il portafoglio è un unico patrimonio ribilanciato ogni anno sul mix target: fino a {glideStartAge} anni resta al {p.equityPctStart}% azionario, poi scivola linearmente fino al {p.equityPctRetirement}% raggiunto a {p.retireAge} anni (stop lavoro), e resta lì per tutta la fase di decumulo. Il rendimento e la tassazione di ogni anno vengono calcolati come media pesata tra azionario e obbligazionario/oro in base al mix di quell'anno.
        </div>
      </details>

      <details>
        <summary>Fondo pensione negoziale</summary>
        <div style={{ padding: "4px 16px 0" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "Helvetica Neue, Arial, sans-serif", fontSize: 13, color: "#12332C", fontWeight: 600, cursor: "pointer" }}>
            <input type="checkbox" checked={p.fondoPensioneAttivo} onChange={(e) => set("fondoPensioneAttivo")(e.target.checked)} />
            Fondo pensione negoziale attivo
          </label>
        </div>
        <div className="group">
          <NumberField label="RAL" value={p.ral} onChange={set("ral")} suffix="€" />
          <NumberField label="Crescita reale RAL (scatti/carriera)" value={p.ralGrowthPct} onChange={set("ralGrowthPct")} step={0.1} suffix="%/anno" />
        </div>
        <div className="group" style={{ opacity: p.fondoPensioneAttivo ? 1 : 0.4, pointerEvents: p.fondoPensioneAttivo ? "auto" : "none" }}>
          <NumberField label="% TFR su RAL" value={p.tfrPct} onChange={set("tfrPct")} step={0.1} suffix="%" />
          <NumberField label="% datore" value={p.datorePct} onChange={set("datorePct")} step={0.05} suffix="%" />
          <NumberField label="% dipendente" value={p.dipendentePct} onChange={set("dipendentePct")} step={0.1} suffix="%" />
          <NumberField label="Bonus produzione su RAL" value={p.bonusProduzionePct} onChange={set("bonusProduzionePct")} step={0.5} suffix="%" />
          <NumberField label="Rendimento reale fondo" value={p.fondoReturn} onChange={set("fondoReturn")} step={0.1} suffix="%" />
          <NumberField label="Età iscrizione fondo (per il pregresso)" value={p.fondoStartAge} onChange={set("fondoStartAge")} />
          <NumberField label="Saldo fondo già accumulato" value={p.fondoSaldoIniziale} onChange={set("fondoSaldoIniziale")} suffix="€" />
          <NumberField label="Versamento extra post-lavoro" value={p.contribFondoPostLavoro} onChange={set("contribFondoPostLavoro")} suffix="€/anno" />
          <NumberField label="Età inizio rendita fondo" value={p.renditaAge} onChange={set("renditaAge")} />
        </div>
        <div className="note">
          Il bonus di produzione tipicamente si aggira tra il 5% e il 10% della RAL a seconda del CCNL/azienda: imposta il valore corretto per il tuo caso. Il versamento extra dopo lo stop lavoro dà beneficio fiscale (deduzione) solo se hai altro reddito imponibile IRPEF su cui dedurlo. L'accesso al fondo prima dei requisiti pensionistici pubblici è possibile solo tramite RITA, che richiede almeno 20 anni di contributi complessivi e, per l'anticipo fino a 10 anni, almeno 24 mesi di inoccupazione: verifica di rientrare nei requisiti all'età scelta.
        </div>
        <div className="note">
          Per simulare uno scenario che parte più avanti nel tempo (es. "Età attuale" = 40 con un pregresso già in corso): imposta "Età iscrizione fondo" all'età reale in cui hai iniziato a versare (anche se precedente all'età attuale) e "Saldo fondo già accumulato" al valore reale di oggi. Questo serve sia a far partire il fondo dal saldo corretto sia a calcolare correttamente gli anni di iscrizione (che determinano l'aliquota della rendita, dal 15% al 9%) — stessa logica già usata per il montante INPS già maturato, nella sezione qui sotto.
        </div>
      </details>

      <details>
        <summary>INPS</summary>
        <div className="group">
          <NumberField label="Età pensione INPS" value={p.pensionAge} onChange={set("pensionAge")} />
          <NumberField label="Montante INPS già maturato" value={p.inpsMontanteIniziale} onChange={set("inpsMontanteIniziale")} suffix="€" />
          <NumberField label="Aliquota contributiva IVS" value={p.inpsAliquota} onChange={set("inpsAliquota")} step={0.1} suffix="%" />
          <NumberField label="Rivalutazione REALE montante (no nominale)" value={p.inpsRivalutazione} onChange={set("inpsRivalutazione")} step={0.1} suffix="%" />
          <NumberField label="Addizionali regionali+comunali" value={p.addizionaliPct} onChange={set("addizionaliPct")} step={0.1} suffix="%" />
        </div>
        <div className="note">
          Metodo contributivo semplificato: montante = montante già maturato (dai 5 anni passati — stima da correggere con il tuo estratto conto INPS reale) + Σ(RAL×aliquota) rivalutato, × coefficiente di trasformazione dell'età di pensionamento (tabella INPS approssimata).
        </div>
        <div className="note">
          Attenzione a non confondere i due tassi: il tasso ufficiale INPS (variazione media quinquennale del PIL nominale) è stato del 4,04% per il 2025/2026, ma è <b>nominale</b>, gonfiato dall'inflazione molto alta del quinquennio 2020-2024 (2021: ≈0%, 2022: 0,98%, 2023: 2,31%, 2024: 3,66%, 2025: 4,04% — un trend salito solo perché gli anni di inflazione all'8-11% sono dentro la finestra mobile a 5 anni). Quando quegli anni usciranno dalla finestra (verso il 2027-28), il tasso nominale dovrebbe ridiscendere.
          <br /><br />
          <b>Range ragionevole per i prossimi 10 anni</b> (assumendo inflazione verso il target BCE ~2% e crescita reale italiana storicamente bassa): nominale 1,5%–3,5% (centrale ~2-2,5%); <b>reale 0%–1,5% (centrale ~0,5-1%)</b> — quest'ultimo è il valore da inserire qui sotto. Regola il campo verso 0% per uno scenario prudente, verso 1,5% per uno scenario più ottimista sulla crescita italiana.
        </div>
        <div className="group" style={{ marginTop: 4 }}>
          <div className="card" style={{ borderColor: sim.okVecchiaia ? "#12332C" : "#8B3A2B" }}>
            <div className="k">Vecchiaia a {p.pensionAge}: soglia assegno sociale</div>
            <div className="v" style={{ color: sim.okVecchiaia ? "#12332C" : "#8B3A2B" }}>
              {sim.inpsLordaFinale ? `${fmt(sim.inpsLordaFinale)} € / ${fmt(sim.ASSEGNO_SOCIALE_ANNUO_2026)} €` : "—"} {sim.okVecchiaia ? "✓ superata" : "✗ non superata"}
            </div>
          </div>
          <div className="card" style={{ borderColor: sim.okAnticipata64 ? "#12332C" : "#8B3A2B" }}>
            <div className="k">Anticipata a 64: soglia 3× assegno sociale</div>
            <div className="v" style={{ color: sim.okAnticipata64 ? "#12332C" : "#8B3A2B" }}>
              {sim.anticipata64Lorda ? `${fmt(sim.anticipata64Lorda)} € / ${fmt(sim.SOGLIA_ANTICIPATA_64_ANNUA_2026)} €` : "—"} {sim.okAnticipata64 ? "✓ superata" : "✗ non superata"}
            </div>
          </div>
        </div>
        <div className="note">
          Se a 67 anni non superi la soglia dell'assegno sociale (546,24 €/mese nel 2026), la pensione di vecchiaia slitta a 71 anni, dove però bastano 5 anni di contributi invece di 20. Se invece superi già a 64 anni la soglia di 3 volte l'assegno sociale (1.603,23 €/mese nel 2026), puoi accedere alla pensione anticipata contributiva 3 anni prima del percorso ordinario. Soglie riferite al 2026, si aggiornano ogni anno.
        </div>
        <div className="note">
          Come vengono tassati lordo → netto: la rendita del fondo pensione usa l'imposta sostitutiva reale, dal 15% al 9% in base agli anni di iscrizione (nel tuo scenario attuale: {(sim.aliquotaRendita * 100).toFixed(1)}%). La pensione INPS usa ora l'IRPEF a scaglioni reale (23% fino a 28.000€, 33% fino a 50.000€, 43% oltre), con la detrazione da pensione che si riduce salendo di reddito, più l'addizionale regionale+comunale impostata sopra — non più un'aliquota media forfettaria. Non considera eventuali altri redditi imponibili nello stesso anno, che farebbero salire l'aliquota marginale.
        </div>
      </details>

      <details>
        <summary>Spese a intervalli (es. figli)</summary>
        <div style={{ padding: "4px 16px 16px" }}>
          {(p.speseIntervalli || []).length === 0 && (
            <div className="note" style={{ marginTop: 0 }}>Nessun intervallo impostato. Usalo per un aumento di spesa temporaneo e poi decrescente (es. figli), invece di una crescita permanente che continuerebbe salendo per sempre.</div>
          )}
          {(p.speseIntervalli || []).map((s) => (
            <div key={s.id} style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 10, flexWrap: "wrap" }}>
              <label className="field" style={{ flex: "1 1 120px" }}>
                <span className="field-label">Descrizione</span>
                <div className="field-input">
                  <input type="text" value={s.label} onChange={(e) => updateSpesaIntervallo(s.id, "label", e.target.value)} />
                </div>
              </label>
              <div style={{ flex: "0 0 90px" }}>
                <NumberField label="Da età" value={s.startAge} onChange={(v) => updateSpesaIntervallo(s.id, "startAge", v)} />
              </div>
              <div style={{ flex: "0 0 90px" }}>
                <NumberField label="A età" value={s.endAge} onChange={(v) => updateSpesaIntervallo(s.id, "endAge", v)} />
              </div>
              <label className="field" style={{ flex: "0 0 130px" }}>
                <span className="field-label">Tipo</span>
                <div className="field-input">
                  <select value={s.type} onChange={(e) => updateSpesaIntervallo(s.id, "type", e.target.value)} style={{ border: "none", background: "transparent", padding: "7px 8px", width: "100%", fontSize: 13.5, fontFamily: "Helvetica Neue" }}>
                    <option value="abs">Valore assoluto €</option>
                    <option value="pct">% delle spese base</option>
                  </select>
                </div>
              </label>
              <div style={{ flex: "0 0 130px" }}>
                <NumberField label={s.type === "pct" ? "Incremento" : "Incremento"} value={s.value} onChange={(v) => updateSpesaIntervallo(s.id, "value", v)} suffix={s.type === "pct" ? "%" : "€/anno"} />
              </div>
              <button
                onClick={() => updateSpesaIntervallo(s.id, "linkPac", !s.linkPac)}
                style={{
                  border: s.linkPac ? "1px solid #12332C" : "1px solid #D9D3C4",
                  background: s.linkPac ? "#12332C" : "#FBFAF6",
                  color: s.linkPac ? "#F5F3EE" : "#5C6B67",
                  borderRadius: 3, padding: "7px 12px", fontFamily: "Helvetica Neue", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap"
                }}
              >
                {s.linkPac ? "✓ Collegato al PAC" : "Collega al PAC"}
              </button>
              <div style={{ flex: "0 0 120px", opacity: s.linkPac ? 1 : 0.4, pointerEvents: s.linkPac ? "auto" : "none" }}>
                <NumberField label="Riduzione PAC" value={s.reduzionePct} onChange={(v) => updateSpesaIntervallo(s.id, "reduzionePct", v)} suffix="%" />
              </div>
              <button
                onClick={() => removeSpesaIntervallo(s.id)}
                style={{ border: "1px solid #D9D3C4", background: "#FBFAF6", borderRadius: 3, padding: "7px 12px", fontFamily: "Helvetica Neue", fontSize: 12, color: "#8B3A2B", cursor: "pointer" }}
              >
                Rimuovi
              </button>
            </div>
          ))}
          <button
            onClick={addSpesaIntervallo}
            style={{ border: "1px solid #12332C", background: "#12332C", color: "#F5F3EE", borderRadius: 3, padding: "8px 14px", fontFamily: "Helvetica Neue", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
          >
            + Aggiungi intervallo di spesa
          </button>
        </div>
        <div className="note">
          Più intervalli si sommano se si sovrappongono (es. due figli in contemporanea). L'incremento percentuale è calcolato sulla spesa vive base impostata sopra, non componendo con la crescita reale annua — resta un valore costante nell'intervallo, non composto.
        </div>
        <div className="note">
          "Collega al PAC": durante l'intervallo, il versamento annuo al PAC si riduce dello stesso importo dell'aumento di spesa (moltiplicato per la % di riduzione impostata, default 100% = riduzione piena, "un euro spostato da una tasca all'altra"). Solo un valore inferiore al 100% ti fa assorbire parte dell'aumento riducendo comunque un po' il risparmio (es. 50% = dividi l'aumento a metà tra risparmio e spesa corrente). Ha effetto solo negli anni in cui stai ancora lavorando.
        </div>
        <div className="note">
          <b>Indicazioni di massima sul costo di un figlio</b> (il costo marginale non è lineare, ha una forma a campana):
          <br />• 0-5 anni: incremento contenuto, spesso già assorbito da una stima prudente della spesa base (pannolini, nido — se rimborsato in parte, l'impatto è ancora minore).
          <br />• 6-10 anni (primaria): primo salto, indicativamente +1.500-2.500€/anno (materiale scolastico, attività extra).
          <br />• 11-17 anni (adolescenza): salto più consistente, ulteriori +2.000-4.000€/anno (tecnologia, socialità, sport più impegnativi).
          <br />• 18+ anni: molto variabile (università, permanenza in famiglia), poi cala quando diventa autonomo.
          <br />Un secondo figlio, per le economie di scala familiari, aggiunge tipicamente circa il 70-80% dell'incremento marginale del primo, non un raddoppio pieno.
        </div>
      </details>

      <details>
        <summary>Spese straordinarie una tantum</summary>
        <div style={{ padding: "4px 16px 16px" }}>
          {(p.speseExtra || []).length === 0 && (
            <div className="note" style={{ marginTop: 0 }}>Nessuna spesa straordinaria impostata. Aggiungi una voce per simulare l'acquisto di un'auto, una ristrutturazione, ecc.</div>
          )}
          {(p.speseExtra || []).map((s) => (
            <div key={s.id} style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 10, flexWrap: "wrap" }}>
              <label className="field" style={{ flex: "1 1 140px" }}>
                <span className="field-label">Descrizione</span>
                <div className="field-input">
                  <input type="text" value={s.label} onChange={(e) => updateSpesaExtra(s.id, "label", e.target.value)} />
                </div>
              </label>
              <div style={{ flex: "0 0 100px" }}>
                <NumberField label="Età" value={s.age} onChange={(v) => updateSpesaExtra(s.id, "age", v)} />
              </div>
              <div style={{ flex: "0 0 140px" }}>
                <NumberField label="Importo" value={s.amount} onChange={(v) => updateSpesaExtra(s.id, "amount", v)} suffix="€" />
              </div>
              <button
                onClick={() => removeSpesaExtra(s.id)}
                style={{ border: "1px solid #D9D3C4", background: "#FBFAF6", borderRadius: 3, padding: "7px 12px", fontFamily: "Helvetica Neue", fontSize: 12, color: "#8B3A2B", cursor: "pointer" }}
              >
                Rimuovi
              </button>
            </div>
          ))}
          <button
            onClick={addSpesaExtra}
            style={{ border: "1px solid #12332C", background: "#12332C", color: "#F5F3EE", borderRadius: 3, padding: "8px 14px", fontFamily: "Helvetica Neue", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
          >
            + Aggiungi spesa straordinaria
          </button>
        </div>
        <div className="note">
          Ogni spesa viene prelevata dal portafoglio personale in proporzione al mix azionario/obbligazionario del momento (stessa logica dei prelievi ordinari), tassando solo la plusvalenza venduta. Importi già in potere d'acquisto di oggi: essendo il modello interamente in termini reali, non serve gonfiarli per l'inflazione futura — se pensi che un'auto oggi costi 30.000€, inserisci 30.000€ anche per tra 10 anni.
        </div>
      </details>

      <details>
        <summary>Spese, decumulo e tasse</summary>
        <div className="group">
          <NumberField label="Spese vive annue" value={p.speseVive} onChange={set("speseVive")} suffix="€" />
          <NumberField label="Crescita reale spese vive" value={p.speseGrowthPct} onChange={set("speseGrowthPct")} step={0.1} suffix="%/anno" />
          <NumberField label="Cuscinetto minimo sempre mantenuto" value={p.cuscinetto} onChange={set("cuscinetto")} suffix="€" />
          <NumberField label="Speranza di vita" value={p.lifeExpectancy} onChange={set("lifeExpectancy")} />
          <NumberField label="Tassazione plusvalenze azioni" value={p.taxEquity} onChange={set("taxEquity")} step={0.5} suffix="%" />
          <NumberField label="Tassazione plusvalenze obblig./oro" value={p.taxBond} onChange={set("taxBond")} step={0.5} suffix="%" />
        </div>
        <div className="note">
          Il modello lavora già interamente in termini reali (rendimenti al netto inflazione, valori in potere d'acquisto di oggi): questi due campi non "aggiungono" inflazione, ma una crescita reale — cioè sopra l'inflazione — nel tempo. Per la RAL rappresenta scatti/avanzamenti di carriera oltre l'adeguamento automatico; per le spese vive un eventuale cambio di stile di vita. Lasciali a 0% per tenere entrambe costanti in termini reali come finora.
        </div>
        <div className="note">
          Prelievi dal portafoglio personale calcolati al lordo dell'imposta sulla sola quota di plusvalenza (non sul capitale versato), in proporzione al mix azionario/obbligazionario di quell'anno secondo il glide path. 12,5% è l'aliquota reale solo per titoli di stato; l'oro fisico/ETC è tassato al 26%, per questo l'aliquota obblig./oro di default è impostata a un valore intermedio (20%) — modificala in base al tuo mix reale.
        </div>
        <div className="note">
          Guardrail cuscinetto: il verdetto in cima alla pagina ora richiede che il portafoglio personale non scenda mai sotto questa soglia, non solo che non si azzeri — un margine per imprevisti, spese straordinarie o mercati peggiori delle attese. Essendo il modello già in termini reali, questo importo resta automaticamente costante in potere d'acquisto, senza bisogno di ulteriori aggiustamenti per l'inflazione.
        </div>
      </details>
    </div>
  );
}