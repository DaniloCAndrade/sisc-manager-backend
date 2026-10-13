/**
 * generate.js
 * Lógica de geração de escala mensal.
 *
 * Regras:
 * - TURNO DIA (07h–19h): ocupado pelo DIURNO da vez no ciclo 12x36.
 *   Se não há DIURNO ou é dia de folga do ciclo → FIXO cobre:
 *     Dia útil: early_sub (07h–16h) + late_sub (10h–19h), round-robin alfabético separado
 *     FDS: um FIXO full_12h (07h–19h), round-robin alfabético único
 *
 * - TURNO NOITE (19h–07h): ocupado pelo NOTURNO da vez no ciclo 12x36.
 *   Se não há NOTURNO ou é dia de folga do ciclo → slot vago (null).
 *   Só vai para substituição se houver ausência real + cadeia manual definida.
 *   Emergência (sem chain, noturno ausente): DIURNO do dia cobre se disponível,
 *   senão FIXO full_12h noturno.
 *
 * - Horários de substituição são FIXOS por tipo:
 *     early_sub  → 07:00–16:00
 *     late_sub   → 10:00–19:00
 *     full_12h   → 07:00–19:00 (dia) ou 19:00–07:00 (noite)
 *
 * - O horarioTrabalho do FIXO aparece apenas no regular_5x2, nunca nas substituições.
 */

const Collaborator = require('../models/Collaborator');
const DailySchedule = require('../models/DailySchedule');
const Absence = require('../models/Absence');
const ScheduleConfig = require('../models/ScheduleConfig');

// ── Helpers de data ───────────────────────────────────────────────

function getDaysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
}

function isWeekend(date) {
    // getUTCDay evita drift de timezone (ex: servidor em UTC-3)
    const d = date.getUTCDay();
    return d === 0 || d === 6;
}

function dayUTC(year, month, day) {
    return new Date(Date.UTC(year, month - 1, day));
}

function diaSemanaStr(date) {
    return date.toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'UTC' });
}

function fmtTime(t) {
    if (!t) return '00:00';
    return `${String(t.hora ?? 0).padStart(2, '0')}:${String(t.minuto ?? 0).padStart(2, '0')}`;
}

function shiftHours(collab) {
    const ht = collab.horarioTrabalho ?? {};
    const start = fmtTime(ht.inicio);
    const end = fmtTime(ht.fim);
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    let hours = (eh * 60 + em - sh * 60 - sm) / 60;
    if (hours <= 0) hours += 24;
    return { start, end, hours: Math.round(hours) };
}

// ── Carrega colaboradores ─────────────────────────────────────────

async function loadCollaborators() {
    const all = await Collaborator.find({ ativo: true }).lean();

    // Ordenação alfabética em todos os grupos
    const sort = (arr) => arr.sort((a, b) => a.nome.localeCompare(b.nome));

    const diurno = sort(all.filter(c => c.subgrupo === 'DIURNO'));
    const noturno = sort(all.filter(c => c.subgrupo === 'NOTURNO'));
    const fixos = sort(all.filter(c => c.subgrupo === 'FIXO'));

    // Cedo: hora inicio ≤ 8h → substitui no slot 07h–16h
    // Tarde: hora inicio > 8h → substitui no slot 10h–19h
    // Se não há nenhum "cedo", todos os FIXO podem cobrir o dia
    const cedo = fixos.filter(c => (c.horarioTrabalho?.inicio?.hora ?? 0) <= 8);
    const tarde = fixos.filter(c => (c.horarioTrabalho?.inicio?.hora ?? 0) > 8);

    return { diurno, noturno, fixos, cedo, tarde };
}

// ── Ausências ─────────────────────────────────────────────────────

async function loadAbsencesForMonth(year, month) {
    const mStart = dayUTC(year, month, 1);
    const mEnd = dayUTC(year, month, getDaysInMonth(year, month));
    return Absence.find({
        $or: [{ 'periodo.fim': null }, { 'periodo.fim': { $gte: mStart } }],
        'periodo.inicio': { $lte: mEnd },
    }).lean();
}

function isAbsent(absences, collaboratorId, dateUTC) {
    const cidStr = String(collaboratorId);
    return absences.some(a => {
        if (String(a.collaboratorId) !== cidStr) return false;
        const start = new Date(a.periodo.inicio).getTime();
        const end = a.periodo.fim ? new Date(a.periodo.fim).getTime() : Infinity;
        return dateUTC.getTime() >= start && dateUTC.getTime() <= end;
    });
}

function getAbsence(absences, collaboratorId, dateUTC) {
    const cidStr = String(collaboratorId);
    return absences.find(a => {
        if (String(a.collaboratorId) !== cidStr) return false;
        const start = new Date(a.periodo.inicio).getTime();
        const end = a.periodo.fim ? new Date(a.periodo.fim).getTime() : Infinity;
        return dateUTC.getTime() >= start && dateUTC.getTime() <= end;
    }) ?? null;
}

// ── Round-robin ───────────────────────────────────────────────────

function pickWorker(pool, startIdx, dateUTC, absences, excludeIds = []) {
    const excludeStr = excludeIds.map(String);
    for (let i = 0; i < pool.length; i++) {
        const candidate = pool[(startIdx + i) % pool.length];
        if (excludeStr.includes(String(candidate._id))) continue;
        if (isAbsent(absences, candidate._id, dateUTC)) continue;
        return { worker: candidate, nextIdx: (startIdx + i + 1) % pool.length };
    }
    return { worker: null, nextIdx: (startIdx + 1) % Math.max(pool.length, 1) };
}

// ── Configuração do mês ───────────────────────────────────────────

async function getOrDeriveConfig(year, month) {
    const existing = await ScheduleConfig.findOne({ ano: year, mes: month }).lean();
    if (existing) return existing;

    let prevYear = year, prevMonth = month - 1;
    if (prevMonth === 0) { prevMonth = 12; prevYear = year - 1; }

    const prev = await ScheduleConfig.findOne({ ano: prevYear, mes: prevMonth }).lean();
    if (!prev) {
        return {
            dayStartIndex: 0, nightStartIndex: 0,
            substitutionState: { cedoIdx: 0, tardeIdx: 0, fixoIdx: 0 },
        };
    }

    const prevDays = getDaysInMonth(prevYear, prevMonth);
    return {
        dayStartIndex: (prev.dayStartIndex + prevDays) % Math.max(prev._numDiurno || 2, 1),
        nightStartIndex: (prev.nightStartIndex + prevDays) % Math.max(prev._numNoturno || 2, 1),
        substitutionState: {
            cedoIdx: prev.substitutionState?.cedoIdx ?? 0,
            tardeIdx: prev.substitutionState?.tardeIdx ?? 0,
            fixoIdx: prev.substitutionState?.fixoIdx ?? 0,
        },
    };
}

// ── Geração mensal ────────────────────────────────────────────────

async function generateMonthSchedule(year, month) {
    const cols = await loadCollaborators();
    const absences = await loadAbsencesForMonth(year, month);
    const config = await getOrDeriveConfig(year, month);

    const { dayStartIndex, nightStartIndex } = config;
    let { cedoIdx = 0, tardeIdx = 0, fixoIdx = 0 } = config.substitutionState ?? {};

    const daysInMonth = getDaysInMonth(year, month);
    const numDiurno = cols.diurno.length;
    const numNoturno = cols.noturno.length;

    // Ciclo 12x36:
    // cycleLen = N*2 pois cada colaborador trabalha N dias e folga N dias
    // Com N=1: ciclo 2 (trabalha dia 1, folga dia 2)
    // Com N=2: ciclo 4... MAS isso gera 2 dias seguidos trabalhando e 2 folgando
    // O correto para 12x36 ALTERNADO: cycleLen = N, e cada posição = 1 colaborador
    // Isso faz: com N=2 -> dia1=A, dia2=B, dia3=A, dia4=B (alternado correto)
    // Com N=1 -> dia1=A, dia2=A, dia3=A... (todos os dias, errado para 12x36 puro)
    // Para N=1 em 12x36 REAL: usar cycleLen=2, working = idx < 1
    const diurnoCycleLen = numDiurno > 1 ? numDiurno : 2;
    const noturnoCycleLen = numNoturno > 1 ? numNoturno : 2;

    const days = [];

    for (let d = 1; d <= daysInMonth; d++) {
        const dateUTC = dayUTC(year, month, d);
        const weekend = isWeekend(dateUTC);
        const diaSem = diaSemanaStr(dateUTC);

        // ── Quem está de plantão hoje? ────────────────────────────
        const diurnoSlotIdx = numDiurno > 0 ? (dayStartIndex + d - 1) % diurnoCycleLen : -1;
        const noturnoSlotIdx = numNoturno > 0 ? (nightStartIndex + d - 1) % noturnoCycleLen : -1;

        // working: índice < numColabs significa que há alguém alocado hoje
        // Com N=1, cycleLen=2: idx=0 trabalha, idx=1 folga
        // Com N=2, cycleLen=2: idx=0=A, idx=1=B, ambos sempre trabalham
        const diurnoWorking = diurnoSlotIdx >= 0 && diurnoSlotIdx < numDiurno;
        const noturnoWorking = noturnoSlotIdx >= 0 && noturnoSlotIdx < numNoturno;

        const diurnoCollab = diurnoWorking ? cols.diurno[diurnoSlotIdx] : null;
        const noturnoCollab = noturnoWorking ? cols.noturno[noturnoSlotIdx] : null;

        // Ausência real (atestado/férias/licença)
        const diurnoAbsent = diurnoCollab ? isAbsent(absences, diurnoCollab._id, dateUTC) : false;
        const noturnoAbsent = noturnoCollab ? isAbsent(absences, noturnoCollab._id, dateUTC) : false;

        // Slot vago = sem colaborador alocado OU ausente
        const diaVago = !diurnoCollab || diurnoAbsent;
        const noiteVaga = !noturnoCollab || noturnoAbsent;

        const substitutions = [];
        let dayShift = null;
        let nightShift = null;

        // ── TURNO DIA ─────────────────────────────────────────────
        if (!diaVago) {
            dayShift = {
                collaboratorId: diurnoCollab._id,
                nome: diurnoCollab.nome,
                start: '07:00', end: '19:00',
                absent: false,
            };
        } else {
            // Slot dia vago — FIXO cobre com horários FIXOS de substituição
            if (weekend) {
                // FDS: um FIXO, dia inteiro 07h–19h
                const { worker, nextIdx } = pickWorker(cols.fixos, fixoIdx, dateUTC, absences);
                fixoIdx = nextIdx;
                if (worker) {
                    substitutions.push({
                        collaboratorId: worker._id, nome: worker.nome,
                        start: '07:00', end: '19:00', hours: 12,
                        type: 'full_12h', confirmed: true, auto: true,
                    });
                }
            } else {
                // Dia útil: early 07h–16h + late 10h–19h
                // Pool cedo: quem entra às 7h (≤8h)
                const poolCedo = cols.cedo.length > 0 ? cols.cedo : cols.fixos;

                const { worker: wCedo, nextIdx: ni1 } = pickWorker(poolCedo, cedoIdx, dateUTC, absences);
                cedoIdx = ni1;

                // Pool tarde: cols.fixos excluindo quem já foi para o cedo neste dia
                // tardeIdx referencia cols.fixos completo para manter rotação correta
                const excludeCedo = wCedo ? [wCedo._id] : [];
                const { worker: wTarde, nextIdx: ni2 } = pickWorker(cols.fixos, tardeIdx, dateUTC, absences, excludeCedo);
                tardeIdx = ni2;

                if (wCedo) substitutions.push({ collaboratorId: wCedo._id, nome: wCedo.nome, start: '07:00', end: '16:00', hours: 9, type: 'early_sub', confirmed: true, auto: true });
                if (wTarde) substitutions.push({ collaboratorId: wTarde._id, nome: wTarde.nome, start: '10:00', end: '19:00', hours: 9, type: 'late_sub', confirmed: true, auto: true });
            }
        }

        // ── TURNO NOITE ───────────────────────────────────────────
        if (!noiteVaga) {
            nightShift = {
                collaboratorId: noturnoCollab._id,
                nome: noturnoCollab.nome,
                start: '19:00', end: '07:00',
                absent: false,
            };
        } else if (noturnoCollab && noturnoAbsent) {
            // Ausência real do NOTURNO — verifica cadeia manual
            const absence = getAbsence(absences, noturnoCollab._id, dateUTC);
            const chain = absence?.substitutionChain ?? {};

            if (chain.nightSubId) {
                // Substituição manual: DIURNO específico vai para a noite
                const nightSub = cols.diurno.find(c => String(c._id) === String(chain.nightSubId));
                if (nightSub && !isAbsent(absences, nightSub._id, dateUTC)) {
                    substitutions.push({
                        collaboratorId: nightSub._id, nome: nightSub.nome,
                        start: '19:00', end: '07:00', hours: 12,
                        type: 'day_to_night_12x36', confirmed: true, auto: false,
                    });
                    // O slot dia do DIURNO que foi para noite ficou vago
                    if (!diaVago && String(diurnoCollab?._id) === String(nightSub._id)) {
                        // O diurno do dia foi mandado para noite → slot dia agora vago
                        dayShift = null;
                        if (weekend) {
                            const { worker, nextIdx } = pickWorker(cols.fixos, fixoIdx, dateUTC, absences);
                            fixoIdx = nextIdx;
                            if (worker) substitutions.push({ collaboratorId: worker._id, nome: worker.nome, start: '07:00', end: '19:00', hours: 12, type: 'full_12h', confirmed: true, auto: true });
                        } else {
                            const poolCedo2 = cols.cedo.length > 0 ? cols.cedo : cols.fixos;
                            const { worker: wC, nextIdx: ni1 } = pickWorker(poolCedo2, cedoIdx, dateUTC, absences);
                            cedoIdx = ni1;
                            const excludeCedo2 = wC ? [wC._id] : [];
                            const { worker: wT, nextIdx: ni2 } = pickWorker(cols.fixos, tardeIdx, dateUTC, absences, excludeCedo2);
                            tardeIdx = ni2;
                            if (wC) substitutions.push({ collaboratorId: wC._id, nome: wC.nome, start: '07:00', end: '16:00', hours: 9, type: 'early_sub', confirmed: true, auto: true });
                            if (wT) substitutions.push({ collaboratorId: wT._id, nome: wT.nome, start: '10:00', end: '19:00', hours: 9, type: 'late_sub', confirmed: true, auto: true });
                        }
                    }
                }
            } else {
                // Sem cadeia — emergência:
                // 1. DIURNO do dia cobre a noite (se disponível e não é o mesmo que já foi para noite)
                // 2. Senão FIXO cobre
                if (diurnoCollab && !diurnoAbsent) {
                    substitutions.push({
                        collaboratorId: diurnoCollab._id, nome: diurnoCollab.nome,
                        start: '19:00', end: '07:00', hours: 12,
                        type: 'day_to_night_12x36', confirmed: true, auto: true,
                    });
                } else {
                    const { worker, nextIdx } = pickWorker(cols.fixos, fixoIdx, dateUTC, absences);
                    fixoIdx = nextIdx;
                    if (worker) {
                        substitutions.push({
                            collaboratorId: worker._id, nome: worker.nome,
                            start: '19:00', end: '07:00', hours: 12,
                            type: 'full_12h', confirmed: true, auto: true,
                        });
                    }
                }
            }
        }
        // Se noiteVaga mas não há noturno cadastrado → slot fica null sem substituição automática
        // (situação normal quando não há noturno no sistema)

        // ── Regular 5x2 (dias úteis) — exclui ausentes no dia ───
        const regular5x2 = weekend ? [] : cols.fixos
            .filter(c => !isAbsent(absences, c._id, dateUTC))
            .map(c => ({
                collaboratorId: c._id,
                nome: c.nome,
                ...shiftHours(c),
                working: true,
            }));

        days.push({
            data: dateUTC,
            ano: year, mes: month, dia: d,
            diaSemana: diaSem,
            isWeekend: weekend,
            day_shift: dayShift,
            night_shift: nightShift,
            regular_5x2: regular5x2,
            substitutions,
            overnight_5x2: null,
            opening_overnight_5x2: null,
            notes: '',
        });
    }

    // Salva no MongoDB
    const ops = days.map(day => ({
        updateOne: {
            filter: { data: day.data },
            update: { $set: day },
            upsert: true,
        },
    }));
    await DailySchedule.bulkWrite(ops);

    // Salva config do mês
    await ScheduleConfig.findOneAndUpdate(
        { ano: year, mes: month },
        {
            ano: year, mes: month,
            dayStartIndex, nightStartIndex,
            _numDiurno: numDiurno,
            _numNoturno: numNoturno,
            substitutionState: { cedoIdx, tardeIdx, fixoIdx },
            geradoEm: new Date(),
        },
        { upsert: true, new: true },
    );

    return days;
}

// ── Regeneração em cascata ────────────────────────────────────────

async function regenerateAffectedMonths(triggerAbsence) {
    const absStart = new Date(triggerAbsence.periodo.inicio);
    const absEnd = triggerAbsence.periodo.fim ? new Date(triggerAbsence.periodo.fim) : null;

    const configs = await ScheduleConfig.find({}).sort({ ano: 1, mes: 1 }).lean();
    const regenerated = [];

    for (const cfg of configs) {
        const { ano, mes } = cfg;
        const mStart = dayUTC(ano, mes, 1);
        const mEnd = dayUTC(ano, mes, getDaysInMonth(ano, mes));

        const overlaps = absStart <= mEnd && (absEnd === null || absEnd >= mStart);
        if (!overlaps) continue;

        // Preserva overnight/opening/notes
        const existing = await DailySchedule.find({ ano, mes }).lean();
        const preserved = {};
        for (const doc of existing) {
            preserved[doc.dia] = {
                overnight_5x2: doc.overnight_5x2 ?? null,
                opening_overnight_5x2: doc.opening_overnight_5x2 ?? null,
                notes: doc.notes ?? '',
            };
        }

        await generateMonthSchedule(ano, mes);

        // Restaura
        for (const [diaStr, data] of Object.entries(preserved)) {
            if (!data.overnight_5x2 && !data.opening_overnight_5x2 && !data.notes) continue;
            const update = {};
            if (data.overnight_5x2) update.overnight_5x2 = data.overnight_5x2;
            if (data.opening_overnight_5x2) update.opening_overnight_5x2 = data.opening_overnight_5x2;
            if (data.notes) update.notes = data.notes;
            await DailySchedule.updateOne({ ano, mes, dia: parseInt(diaStr) }, { $set: update });
        }

        regenerated.push(`${ano}-${String(mes).padStart(2, '0')}`);
    }

    return regenerated;
}

// ── Sugestões ─────────────────────────────────────────────────────

async function suggestSubstitution(shiftType, dateUTC, ano, mes, dia) {
    const cols = await loadCollaborators();
    const absences = await loadAbsencesForMonth(ano, mes);
    const dayData = await DailySchedule.findOne({ ano, mes, dia }).lean();
    const weekend = isWeekend(dateUTC);

    const busyIds = new Set([
        ...(dayData?.substitutions ?? []).map(s => String(s.collaboratorId)),
        dayData?.overnight_5x2?.collaboratorId ? String(dayData.overnight_5x2.collaboratorId) : null,
    ].filter(Boolean));

    const available = cols.fixos.filter(c =>
        !busyIds.has(String(c._id)) && !isAbsent(absences, c._id, dateUTC)
    );

    if (shiftType === 'night' || weekend) {
        const candidate = available[0];
        if (!candidate) return [];
        return [{
            collaboratorId: candidate._id, nome: candidate.nome,
            start: shiftType === 'night' ? '19:00' : '07:00',
            end: shiftType === 'night' ? '07:00' : '19:00',
            hours: 12, type: 'full_12h', confirmed: false,
        }];
    }

    const poolCedo = cols.cedo.length > 0 ? cols.cedo.filter(c => !busyIds.has(String(c._id)) && !isAbsent(absences, c._id, dateUTC)) : available;
    const poolTarde = cols.tarde.length > 0 ? cols.tarde.filter(c => !busyIds.has(String(c._id)) && !isAbsent(absences, c._id, dateUTC)) : available;

    const suggestions = [];
    if (poolCedo[0]) suggestions.push({ collaboratorId: poolCedo[0]._id, nome: poolCedo[0].nome, start: '07:00', end: '16:00', hours: 9, type: 'early_sub', confirmed: false });
    if (poolTarde[0]) suggestions.push({ collaboratorId: poolTarde[0]._id, nome: poolTarde[0].nome, start: '10:00', end: '19:00', hours: 9, type: 'late_sub', confirmed: false });
    return suggestions;
}

async function suggestNextOvernight(ano, mes) {
    const cols = await loadCollaborators();
    const sorted = cols.fixos;
    const lastDay = await DailySchedule.findOne({ ano, mes, overnight_5x2: { $ne: null } }).sort({ dia: -1 }).lean();
    if (!lastDay?.overnight_5x2) return sorted[0] ?? null;
    const lastIdx = sorted.findIndex(c => String(c._id) === String(lastDay.overnight_5x2.collaboratorId));
    return sorted[(lastIdx + 1) % sorted.length] ?? null;
}

module.exports = {
    generateMonthSchedule,
    regenerateAffectedMonths,
    suggestSubstitution,
    suggestNextOvernight,
    getDaysInMonth,
    isWeekend,
    dayUTC,
};