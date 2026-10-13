const DailySchedule = require('../models/DailySchedule');
const ScheduleConfig = require('../models/ScheduleConfig');
const Collaborator = require('../models/Collaborator');
const {
    generateMonthSchedule, suggestSubstitution,
    suggestNextOvernight, getDaysInMonth, dayUTC, isWeekend,
} = require('./generate');

// ── POST /api/dailySchedule/gerarEscalaPeriodo ────────────────────
// Body: { inicio: Date, fim: Date }
const gerarEscalaPeriodo = async (req, res) => {
    try {
        const { inicio, fim } = req.body;
        if (!inicio || !fim) return res.status(400).json({ success: false, message: 'inicio e fim são obrigatórios.' });

        const start = new Date(inicio);
        const end = new Date(fim);

        // Coleta os meses únicos no intervalo
        const months = new Set();
        const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
        while (cur <= end) {
            months.add(`${cur.getUTCFullYear()}-${cur.getUTCMonth() + 1}`);
            cur.setUTCMonth(cur.getUTCMonth() + 1);
        }

        const generated = [];
        for (const key of months) {
            const [ano, mes] = key.split('-').map(Number);
            await generateMonthSchedule(ano, mes);
            generated.push(key);
        }

        const days = await DailySchedule.find({
            data: {
                $gte: dayUTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()),
                $lte: dayUTC(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate())
            },
        }).sort({ data: 1 }).lean();

        return res.status(201).json({ success: true, data: days, message: `${generated.length} mês(es) gerado(s).` });
    } catch (err) {
        console.error('[DailySchedule] gerarEscalaPeriodo:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── POST /api/dailySchedule/buscaTabelaPeriodo ────────────────────
// Body: { inicio: Date, fim: Date }
const buscaTabelaPeriodo = async (req, res) => {
    try {
        const { inicio, fim } = req.body;
        if (!inicio || !fim) return res.status(400).json({ success: false, message: 'inicio e fim são obrigatórios.' });

        const start = new Date(inicio);
        const end = new Date(fim);

        const days = await DailySchedule.find({
            data: {
                $gte: dayUTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()),
                $lte: dayUTC(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate()),
            },
        }).sort({ data: 1 }).lean();

        return res.json({ success: true, data: days });
    } catch (err) {
        console.error('[DailySchedule] buscaTabelaPeriodo:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── POST /api/dailySchedule/buscarEscalaPeriodo ───────────────────
// Alias de buscaTabelaPeriodo (compatibilidade com frontend antigo)
const buscarEscalaPeriodo = buscaTabelaPeriodo;

// ── PUT /api/dailySchedule/:id ────────────────────────────────────
// Atualiza campos livres de um dia (notes, substituições, overnight)
const atualizarEscala = async (req, res) => {
    try {
        const { id } = req.params;
        const allowed = ['notes', 'substitutions', 'overnight_5x2', 'opening_overnight_5x2', 'regular_5x2', 'day_shift', 'night_shift'];
        const update = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) update[key] = req.body[key];
        }
        update.atualizadoEm = new Date();

        const doc = await DailySchedule.findByIdAndUpdate(id, { $set: update }, { new: true });
        if (!doc) return res.status(404).json({ success: false, message: 'Dia não encontrado.' });

        return res.json({ success: true, data: doc });
    } catch (err) {
        console.error('[DailySchedule] atualizarEscala:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── PATCH /api/dailySchedule/:ano/:mes/:dia/absence ───────────────
const marcarAusencia = async (req, res) => {
    try {
        const { ano, mes, dia } = req.params;
        const { shift, absent = true } = req.body;

        if (!shift) return res.status(400).json({ success: false, message: 'Campo "shift" obrigatório (day|night)' });

        const doc = await DailySchedule.findOne({ ano: +ano, mes: +mes, dia: +dia });
        if (!doc) return res.status(404).json({ success: false, message: 'Dia não encontrado.' });

        const field = shift === 'day' ? 'day_shift' : 'night_shift';
        doc[field].absent = absent;

        let suggestions = [];
        if (absent) {
            const dateUTC_ = dayUTC(+ano, +mes, +dia);
            suggestions = await suggestSubstitution(shift, dateUTC_, +ano, +mes, +dia);
        } else {
            doc.substitutions = doc.substitutions.filter(s => !s.auto);
        }

        await doc.save();
        return res.json({ success: true, data: doc, suggestions });
    } catch (err) {
        console.error('[DailySchedule] marcarAusencia:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── PATCH /api/dailySchedule/:ano/:mes/:dia/substitutions ─────────
const atualizarSubstituicoes = async (req, res) => {
    try {
        const { ano, mes, dia } = req.params;
        const { substitutions } = req.body;

        if (!Array.isArray(substitutions)) return res.status(400).json({ success: false, message: '"substitutions" deve ser array' });

        const doc = await DailySchedule.findOneAndUpdate(
            { ano: +ano, mes: +mes, dia: +dia },
            { $set: { substitutions, atualizadoEm: new Date() } },
            { new: true },
        );
        if (!doc) return res.status(404).json({ success: false, message: 'Dia não encontrado.' });

        return res.json({ success: true, data: doc });
    } catch (err) {
        console.error('[DailySchedule] atualizarSubstituicoes:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── POST /api/dailySchedule/:ano/:mes/:dia/overnight ──────────────
const registrarOvernight = async (req, res) => {
    try {
        const { ano, mes, dia } = req.params;
        const { collaboratorId, programName, remove } = req.body;

        const doc = await DailySchedule.findOne({ ano: +ano, mes: +mes, dia: +dia });
        if (!doc) return res.status(404).json({ success: false, message: 'Dia não encontrado.' });

        if (remove) {
            doc.overnight_5x2 = null;
            await doc.save();
            return res.json({ success: true, data: doc, message: 'Plantão removido.' });
        }

        if (!collaboratorId) return res.status(400).json({ success: false, message: 'collaboratorId obrigatório' });

        const collab = await Collaborator.findById(collaboratorId).lean();
        if (!collab) return res.status(404).json({ success: false, message: 'Colaborador não encontrado.' });

        doc.overnight_5x2 = { collaboratorId: collab._id, nome: collab.nome, start: '19:00', end: '07:00', hours: 12, programName: programName || null };
        await doc.save();
        return res.json({ success: true, data: doc, message: 'Plantão registrado.' });
    } catch (err) {
        console.error('[DailySchedule] registrarOvernight:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── GET /api/dailySchedule/:ano/:mes/:dia/suggest-overnight ───────
const sugerirOvernight = async (req, res) => {
    try {
        const { ano, mes } = req.params;
        const suggestion = await suggestNextOvernight(+ano, +mes);
        return res.json({ success: true, suggestion });
    } catch (err) {
        console.error('[DailySchedule] sugerirOvernight:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── POST /api/dailySchedule/gerarRelatorioCSV ─────────────────────
const gerarRelatorioCSV = async (req, res) => {
    try {
        const { inicio, fim } = req.body;
        if (!inicio || !fim) return res.status(400).json({ success: false, message: 'inicio e fim são obrigatórios.' });

        const start = new Date(inicio);
        const end = new Date(fim);

        const days = await DailySchedule.find({
            data: {
                $gte: dayUTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()),
                $lte: dayUTC(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate()),
            },
        }).sort({ data: 1 }).lean();

        // Monta CSV
        const header = 'Data,Dia da Semana,Turno Dia,Ausente Dia,Turno Noite,Ausente Noite,Substituições,Overnight\n';
        const rows = days.map(d => {
            const subs = (d.substitutions || []).map(s => `${s.nome}(${s.start}-${s.end})`).join('; ');
            const ov = d.overnight_5x2 ? `${d.overnight_5x2.nome}(${d.overnight_5x2.start}-${d.overnight_5x2.end})` : '';
            return [
                new Date(d.data).toLocaleDateString('pt-BR'),
                d.diaSemana,
                d.day_shift?.nome ?? '',
                d.day_shift?.absent ? 'Sim' : 'Não',
                d.night_shift?.nome ?? '',
                d.night_shift?.absent ? 'Sim' : 'Não',
                subs, ov,
            ].join(',');
        }).join('\n');

        const csv = header + rows;
        const filename = `escala_${start.toISOString().split('T')[0]}_${end.toISOString().split('T')[0]}.csv`;

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send('\uFEFF' + csv);   // BOM para Excel reconhecer UTF-8
    } catch (err) {
        console.error('[DailySchedule] gerarRelatorioCSV:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

module.exports = {
    gerarEscalaPeriodo,
    buscaTabelaPeriodo,
    buscarEscalaPeriodo,
    atualizarEscala,
    marcarAusencia,
    atualizarSubstituicoes,
    registrarOvernight,
    sugerirOvernight,
    gerarRelatorioCSV,
};