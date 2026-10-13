/**
 * ProgramController.js
 * Gerencia programas de plantão com rotação automática de colaboradores.
 *
 * Tipos de programa:
 *  - commercial : apenas registra o nome nos dias, sem plantonista noturno
 *  - evening    : plantonista 19h–23h59 (5h) + opening 00h–07h no dia seguinte (7h)
 *  - fullnight  : plantonista 19h–07h (12h)
 *
 * Regras:
 *  - Rotação alfabética a partir do firstCollaboratorId
 *  - Ausentes são pulados automaticamente
 *  - Quem fez late_sub (10h–19h) no dia não pode ser o mesmo plantonista noturno
 *    naquele dia → troca com o plantonista do dia seguinte
 *  - Funciona entre meses (salva em múltiplos documentos DailySchedule)
 */

const mongoose = require('mongoose');
const DailySchedule = require('../models/DailySchedule');
const Collaborator = require('../models/Collaborator');
const Absence = require('../models/Absence');
const { dayUTC, getDaysInMonth } = require('./generate');

// ── Helpers ───────────────────────────────────────────────────────

function isAbsentOnDay(absences, collaboratorId, dateUTC) {
    const cidStr = String(collaboratorId);
    return absences.some(a => {
        if (String(a.collaboratorId) !== cidStr) return false;
        const start = new Date(a.periodo.inicio).getTime();
        const end = a.periodo.fim ? new Date(a.periodo.fim).getTime() : Infinity;
        return dateUTC.getTime() >= start && dateUTC.getTime() <= end;
    });
}

async function loadAbsencesForRange(startDate, endDate) {
    return Absence.find({
        $or: [{ 'periodo.fim': null }, { 'periodo.fim': { $gte: startDate } }],
        'periodo.inicio': { $lte: endDate },
    }).lean();
}

/** Gera lista de datas UTC entre start e end (inclusive) */
function dateRange(startDate, endDate) {
    const dates = [];
    const cur = new Date(startDate);
    while (cur <= endDate) {
        dates.push(new Date(cur));
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return dates;
}

/** Retorna o índice do colaborador no pool pelo _id */
function findIdx(pool, collaboratorId) {
    return pool.findIndex(c => String(c._id) === String(collaboratorId));
}

/** Próximo disponível no pool a partir de startIdx, pulando ausentes */
function nextAvailable(pool, startIdx, dateUTC, absences, excludeIds = []) {
    const excludeStr = excludeIds.map(String);
    for (let i = 0; i < pool.length; i++) {
        const candidate = pool[(startIdx + i) % pool.length];
        if (excludeStr.includes(String(candidate._id))) continue;
        if (isAbsentOnDay(absences, candidate._id, dateUTC)) continue;
        return { worker: candidate, nextIdx: (startIdx + i + 1) % pool.length };
    }
    return { worker: null, nextIdx: (startIdx + 1) % pool.length };
}

// ── POST /api/program ─────────────────────────────────────────────
const criarPrograma = async (req, res) => {
    try {
        const {
            programName, tipo, startDate, endDate, firstCollaboratorId,
        } = req.body;

        if (!programName || !tipo || !startDate || !endDate) {
            return res.status(400).json({ success: false, message: 'programName, tipo, startDate e endDate são obrigatórios.' });
        }
        if (!['commercial', 'evening', 'fullnight'].includes(tipo)) {
            return res.status(400).json({ success: false, message: "tipo deve ser 'commercial', 'evening' ou 'fullnight'." });
        }
        if (tipo !== 'commercial' && !firstCollaboratorId) {
            return res.status(400).json({ success: false, message: 'firstCollaboratorId é obrigatório para programas com plantonista.' });
        }

        const start = new Date(startDate + 'T00:00:00Z');
        const end = new Date(endDate + 'T00:00:00Z');
        if (start > end) return res.status(400).json({ success: false, message: 'startDate deve ser anterior ou igual a endDate.' });

        // Pool de colaboradores FIXO em ordem alfabética
        const fixos = await Collaborator.find({ ativo: true, subgrupo: 'FIXO' }).sort({ nome: 1 }).lean();
        if (!fixos.length) return res.status(404).json({ success: false, message: 'Nenhum colaborador FIXO ativo encontrado.' });

        // Absências no período
        const absences = await loadAbsencesForRange(start, end);

        // Ponto de partida na rotação
        let rotIdx = 0;
        if (firstCollaboratorId) {
            const found = findIdx(fixos, firstCollaboratorId);
            if (found === -1) return res.status(404).json({ success: false, message: 'Colaborador inicial não encontrado.' });
            rotIdx = found;
        }

        const dates = dateRange(start, end);
        const updates = []; // { dateUTC, overnight, opening }

        if (tipo === 'commercial') {
            // Apenas registra o programName — sem plantonista
            for (const dateUTC of dates) {
                updates.push({ dateUTC, programName, overnight: null, opening: null });
            }
        } else if (tipo === 'fullnight') {
            // 19h–07h — rotação normal sem pular posições
            // Se houver conflito de late_sub, troca apenas com o dia seguinte na lista
            for (const dateUTC of dates) {
                // Rotação normal — ignora ausentes mas NÃO pula late_sub aqui
                const { worker, nextIdx } = nextAvailable(fixos, rotIdx, dateUTC, absences, []);
                rotIdx = nextIdx;

                updates.push({
                    dateUTC,
                    programName,
                    overnight: worker ? {
                        collaboratorId: worker._id,
                        nome: worker.nome,
                        start: '19:00', end: '07:00', hours: 12,
                        programName,
                    } : null,
                    opening: null,
                });
            }

            // Segunda passagem: resolve conflitos de late_sub trocando com o dia seguinte
            for (let i = 0; i < updates.length - 1; i++) {
                const cur = updates[i];
                const next = updates[i + 1];
                if (!cur.overnight || !next.overnight) continue;

                const dayDoc = await DailySchedule.findOne({
                    ano: cur.dateUTC.getUTCFullYear(),
                    mes: cur.dateUTC.getUTCMonth() + 1,
                    dia: cur.dateUTC.getUTCDate(),
                }).lean();

                const lateSubIds = (dayDoc?.substitutions ?? [])
                    .filter(s => s.type === 'late_sub')
                    .map(s => String(s.collaboratorId));

                if (lateSubIds.includes(String(cur.overnight.collaboratorId))) {
                    // Troca overnight entre dia i e dia i+1 — mantém a rotação, só reposiciona
                    [cur.overnight, next.overnight] = [next.overnight, cur.overnight];
                    cur.overnight.programName = programName;
                    next.overnight.programName = programName;
                }
            }

        } else if (tipo === 'evening') {
            // 19h–23h59 (5h) apenas — a partir de 00h o turno noturno 12x36 assume normalmente
            // Sem opening_overnight_5x2
            for (const dateUTC of dates) {
                const dayDoc = await DailySchedule.findOne({
                    ano: dateUTC.getUTCFullYear(),
                    mes: dateUTC.getUTCMonth() + 1,
                    dia: dateUTC.getUTCDate(),
                }).lean();

                const lateSubs = (dayDoc?.substitutions ?? [])
                    .filter(s => s.type === 'late_sub')
                    .map(s => s.collaboratorId);

                const { worker, nextIdx } = nextAvailable(fixos, rotIdx, dateUTC, absences, lateSubs);
                rotIdx = nextIdx;

                updates.push({
                    dateUTC,
                    programName,
                    overnight: worker ? {
                        collaboratorId: worker._id,
                        nome: worker.nome,
                        start: '19:00', end: '23:59', hours: 5,
                        programName,
                    } : null,
                    opening: null,
                });
            }
        }

        // ── Aplica os updates no banco ────────────────────────────────
        const affected = [];

        for (let i = 0; i < updates.length; i++) {
            const u = updates[i];
            const ano = u.dateUTC.getUTCFullYear();
            const mes = u.dateUTC.getUTCMonth() + 1;
            const dia = u.dateUTC.getUTCDate();

            const setFields = {};
            if (u.overnight !== undefined) setFields.overnight_5x2 = u.overnight;


            if (Object.keys(setFields).length > 0) {
                setFields.atualizadoEm = new Date();
                await DailySchedule.findOneAndUpdate(
                    { ano, mes, dia },
                    { $set: setFields },
                );
                if (u.overnight) {
                    affected.push({ date: `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`, slot: 'overnight', collaborator: u.overnight.nome });
                }
            }
        }

        return res.status(201).json({
            success: true,
            message: `Programa "${programName}" criado. ${affected.length} slot(s) registrado(s).`,
            programName, tipo,
            affected,
        });
    } catch (err) {
        console.error('[ProgramController] criarPrograma:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── GET /api/program?start=YYYY-MM-DD&end=YYYY-MM-DD ─────────────
const listarProgramas = async (req, res) => {
    try {
        const { start, end } = req.query;
        if (!start || !end) return res.status(400).json({ success: false, message: 'start e end são obrigatórios.' });

        const startUTC = new Date(start + 'T00:00:00Z');
        const endUTC = new Date(end + 'T00:00:00Z');

        const days = await DailySchedule.find({
            data: { $gte: startUTC, $lte: endUTC },
            $or: [
                { 'overnight_5x2.programName': { $exists: true, $ne: null } },
                { 'opening_overnight_5x2.programName': { $exists: true, $ne: null } },
            ],
        }).sort({ data: 1 }).lean();

        // Agrupa por programName
        const map = {};
        for (const day of days) {
            for (const [field, slotType] of [['overnight_5x2', 'overnight'], ['opening_overnight_5x2', 'opening']]) {
                const slot = day[field];
                if (!slot?.programName) continue;
                const pn = slot.programName;
                if (!map[pn]) map[pn] = { programName: pn, slots: [], collaborators: new Set() };
                map[pn].slots.push({
                    date: new Date(day.data).toISOString().split('T')[0],
                    diaSemana: day.diaSemana,
                    slot: slotType,
                    collaboratorId: slot.collaboratorId,
                    collaborator: slot.nome,
                    start: slot.start,
                    end: slot.end,
                    hours: slot.hours,
                });
                map[pn].collaborators.add(slot.nome);
            }
        }

        const programs = Object.values(map).map(p => ({
            programName: p.programName,
            totalSlots: p.slots.length,
            collaborators: [...p.collaborators],
            startDate: p.slots[0]?.date ?? null,
            endDate: p.slots[p.slots.length - 1]?.date ?? null,
            slots: p.slots,
        }));

        return res.json({ success: true, data: programs });
    } catch (err) {
        console.error('[ProgramController] listarProgramas:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── DELETE /api/program/:programName?start=&end= ──────────────────
const deletarPrograma = async (req, res) => {
    try {
        const programName = decodeURIComponent(req.params.programName);
        const { start, end } = req.query;

        const filter = {
            $or: [
                { 'overnight_5x2.programName': programName },
                { 'opening_overnight_5x2.programName': programName },
            ],
        };

        if (start && end) {
            filter.data = {
                $gte: new Date(start + 'T00:00:00Z'),
                $lte: new Date(end + 'T00:00:00Z'),
            };
        }

        const days = await DailySchedule.find(filter).lean();
        let removed = 0;

        for (const day of days) {
            const update = {};
            if (day.overnight_5x2?.programName === programName) { update.overnight_5x2 = null; removed++; }
            if (day.opening_overnight_5x2?.programName === programName) { update.opening_overnight_5x2 = null; removed++; }
            if (Object.keys(update).length) {
                update.atualizadoEm = new Date();
                await DailySchedule.updateOne({ _id: day._id }, { $set: update });
            }
        }

        if (!removed) return res.status(404).json({ success: false, message: 'Programa não encontrado.' });
        return res.json({ success: true, message: `Programa "${programName}" removido. ${removed} slot(s) excluído(s).`, removed });
    } catch (err) {
        console.error('[ProgramController] deletarPrograma:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── PUT /api/program/:programName ─────────────────────────────────
// Recria o programa do zero (apaga o antigo e cria o novo)
const atualizarPrograma = async (req, res) => {
    try {
        const oldName = decodeURIComponent(req.params.programName);
        const { start, end } = req.query;

        // Remove o programa antigo
        const delReq = { params: { programName: oldName }, query: { start, end } };
        const delRes = { json: () => { }, status: () => ({ json: () => { } }) };
        await deletarPrograma(delReq, delRes);

        // Cria o novo
        return criarPrograma(req, res);
    } catch (err) {
        console.error('[ProgramController] atualizarPrograma:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

module.exports = { criarPrograma, listarProgramas, deletarPrograma, atualizarPrograma };