/**
 * ExportController.js
 * Dois endpoints de exportação Excel:
 *
 * GET /api/export/escala?inicio=YYYY-MM-DD&fim=YYYY-MM-DD
 *   → Tabela de escala mensal (um dia por linha)
 *
 * GET /api/export/horas-extras?inicio=YYYY-MM-DD&fim=YYYY-MM-DD
 *   → Resumo de horas extras por colaborador FIXO (para o RH)
 *     Conta: full_12h no FDS + overnight_5x2 (fullnight=12h, evening=5h)
 */

const path = require('path');
const { Readable } = require('stream');

let ExcelJS;
try { ExcelJS = require('exceljs'); } catch { ExcelJS = null; }

const DailySchedule = require('../models/DailySchedule');
const { dayUTC } = require('./generate');

// ── Instala exceljs se necessário ─────────────────────────────────
async function ensureExcelJS() {
    if (ExcelJS) return ExcelJS;
    const { execSync } = require('child_process');
    execSync('npm install exceljs --save', { cwd: path.join(__dirname, '..') });
    ExcelJS = require('exceljs');
    return ExcelJS;
}

// ── Helpers ───────────────────────────────────────────────────────

function parseRange(req, res) {
    const { inicio, fim } = req.query;
    if (!inicio || !fim) {
        res.status(400).json({ success: false, message: 'inicio e fim são obrigatórios (YYYY-MM-DD).' });
        return null;
    }
    const start = new Date(inicio + 'T00:00:00Z');
    const end = new Date(fim + 'T00:00:00Z');
    if (isNaN(start) || isNaN(end) || start > end) {
        res.status(400).json({ success: false, message: 'Datas inválidas.' });
        return null;
    }
    return { start, end };
}

function fmtDate(dateVal) {
    // Aceita Date, string ISO ou string YYYY-MM-DD
    const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
    const day = String(d.getUTCDate()).padStart(2, '0');
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const year = d.getUTCFullYear();
    return `${day}/${month}/${year}`;
}

function headerStyle(wb) {
    return {
        font: { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial', size: 10 },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } },
        alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
        border: {
            top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
            bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
            left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
            right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        },
    };
}

function cellStyle(rowIdx, highlight = false) {
    const bg = highlight ? 'FFFEF9C3' : (rowIdx % 2 === 0 ? 'FFF9FAFB' : 'FFFFFFFF');
    return {
        font: { name: 'Arial', size: 9 },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } },
        alignment: { horizontal: 'left', vertical: 'middle', wrapText: true },
        border: {
            top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            right: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        },
    };
}

function applyStyle(cell, style) {
    cell.font = style.font;
    cell.fill = style.fill;
    cell.alignment = style.alignment;
    cell.border = style.border;
}

// ── 1. Export Escala ──────────────────────────────────────────────

const exportEscala = async (req, res) => {
    try {
        const range = parseRange(req, res);
        if (!range) return;
        const { start, end } = range;

        const EJS = await ensureExcelJS();
        const days = await DailySchedule.find({ data: { $gte: start, $lte: end } }).sort({ data: 1 }).lean();

        const wb = new EJS.Workbook();
        wb.creator = 'SISC Manager';
        const ws = wb.addWorksheet('Escala', { views: [{ state: 'frozen', ySplit: 1 }] });

        // Cabeçalhos
        ws.columns = [
            { header: 'Data', key: 'data', width: 12 },
            { header: 'Dia Semana', key: 'diaSem', width: 14 },
            { header: 'FDS', key: 'fds', width: 6 },
            { header: 'Turno Dia', key: 'dayCollab', width: 22 },
            { header: 'Aus. Dia', key: 'dayAbs', width: 10 },
            { header: 'Turno Noite', key: 'nightCollab', width: 22 },
            { header: 'Aus. Noite', key: 'nightAbs', width: 10 },
            { header: 'Substituições', key: 'subs', width: 40 },
            { header: 'Overnight', key: 'overnight', width: 22 },
            { header: 'Programa', key: 'programa', width: 20 },
            { header: 'Observações', key: 'notes', width: 30 },
        ];

        // Estilo do cabeçalho
        ws.getRow(1).height = 28;
        ws.getRow(1).eachCell(cell => applyStyle(cell, headerStyle()));

        // Linhas de dados
        days.forEach((day, i) => {
            const rowIdx = i + 2;
            const isFDS = day.isWeekend;

            const subs = (day.substitutions || []).map(s => {
                const tipo = s.type === 'early_sub' ? '07h–16h'
                    : s.type === 'late_sub' ? '10h–19h'
                        : s.type === 'full_12h' ? (s.start === '07:00' ? '07h–19h' : '19h–07h')
                            : s.type === 'day_to_night_12x36' ? '19h–07h (12x36)'
                                : `${s.start}–${s.end}`;
                return `${s.nome} (${tipo})`;
            }).join(' | ') || '—';

            const overnight = day.overnight_5x2
                ? `${day.overnight_5x2.nome} ${day.overnight_5x2.start}–${day.overnight_5x2.end}`
                : '—';

            const row = ws.addRow({
                data: fmtDate(day.data),
                diaSem: day.diaSemana,
                fds: isFDS ? 'Sim' : 'Não',
                dayCollab: day.day_shift?.nome ?? '—',
                dayAbs: day.day_shift?.absent ? 'Ausente' : '—',
                nightCollab: day.night_shift?.nome ?? '—',
                nightAbs: day.night_shift?.absent ? 'Ausente' : '—',
                subs,
                overnight,
                programa: day.overnight_5x2?.programName ?? day.opening_overnight_5x2?.programName ?? '—',
                notes: day.notes || '—',
            });

            row.height = 20;
            row.eachCell(cell => applyStyle(cell, cellStyle(rowIdx, isFDS)));

            // FDS em amarelo mais forte
            if (isFDS) {
                row.getCell('fds').font = { bold: true, name: 'Arial', size: 9, color: { argb: 'FF92400E' } };
            }
        });

        // Envia o arquivo
        const periodo = `${inicio(req)}_${fim(req)}`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="escala_${periodo}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error('[ExportController] exportEscala:', err.message);
        if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
    }
};

// ── 2. Export Horas Extras ────────────────────────────────────────

const exportHorasExtras = async (req, res) => {
    try {
        const range = parseRange(req, res);
        if (!range) return;
        const { start, end } = range;

        const EJS = await ensureExcelJS();
        const days = await DailySchedule.find({ data: { $gte: start, $lte: end } }).sort({ data: 1 }).lean();

        // Acumula horas por colaborador
        const collabMap = {}; // id → { nome, detalhes[], totalHoras }

        function addHora(collab, dateStr, diaSemana, tipo, horas, obs = '') {
            const key = String(collab.collaboratorId ?? collab._id);
            if (!collabMap[key]) {
                collabMap[key] = { nome: collab.nome, detalhes: [], totalHoras: 0 };
            }
            collabMap[key].detalhes.push({ data: fmtDate(dateStr), diaSemana, tipo, horas, obs });
            collabMap[key].totalHoras += horas;
        }

        for (const day of days) {
            const dateStr = day.data;
            const diaSemana = day.diaSemana;
            const isFDS = day.isWeekend;

            // full_12h no FDS (substituto cobrindo dia inteiro)
            for (const s of (day.substitutions || [])) {
                if (s.type === 'full_12h' && isFDS && s.start === '07:00') {
                    addHora(s, dateStr, diaSemana, 'Substituição FDS (07h–19h)', s.hours ?? 12);
                }
            }

            // overnight_5x2 — fullnight (12h) ou evening (5h)
            if (day.overnight_5x2) {
                const ov = day.overnight_5x2;
                const horas = ov.hours ?? (ov.end === '23:59' ? 5 : 12);
                const tipo = horas === 5 ? 'Plantão Evening (19h–23h59)' : 'Plantão Fullnight (19h–07h)';
                addHora(ov, dateStr, diaSemana, tipo, horas, ov.programName ?? '');
            }
        }

        const EJS2 = await ensureExcelJS();
        const wb = new EJS2.Workbook();
        wb.creator = 'SISC Manager';

        const MONTH_NAMES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
            'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

        const collabs = Object.values(collabMap).sort((a, b) => a.nome.localeCompare(b.nome));

        if (!collabs.length) {
            // Planilha vazia com aviso
            const ws = wb.addWorksheet('Horas Extras');
            ws.addRow(['Nenhuma hora extra encontrada no período.']);
        } else {
            // Aba de resumo geral
            const wsResumo = wb.addWorksheet('Resumo');
            wsResumo.views = [{ state: 'frozen', ySplit: 1 }];
            wsResumo.columns = [
                { header: 'Colaborador', key: 'nome', width: 28 },
                { header: 'Total de Horas', key: 'total', width: 16 },
            ];
            wsResumo.getRow(1).eachCell(cell => applyStyle(cell, headerStyle()));
            wsResumo.getRow(1).height = 28;

            collabs.forEach((c, i) => {
                const row = wsResumo.addRow({ nome: c.nome, total: c.totalHoras });
                row.height = 20;
                row.eachCell(cell => applyStyle(cell, cellStyle(i + 2)));
                row.getCell('total').numFmt = '0"h"';
            });

            // Linha de total
            const totRow = wsResumo.addRow({ nome: 'TOTAL', total: `=SOMA(B2:B${collabs.length + 1})` });
            totRow.height = 22;
            totRow.eachCell(cell => {
                applyStyle(cell, cellStyle(0));
                cell.font = { bold: true, name: 'Arial', size: 10 };
            });
            totRow.getCell('total').numFmt = '0"h"';

            // Uma aba por colaborador
            for (const c of collabs) {
                const wsName = c.nome.substring(0, 31).replace(/[\\/*?:[\]]/g, '');
                const ws = wb.addWorksheet(wsName, { views: [{ state: 'frozen', ySplit: 2 }] });

                // Título
                ws.mergeCells('A1:E1');
                const titleCell = ws.getCell('A1');
                titleCell.value = `Horas Extras — ${c.nome}`;
                titleCell.font = { bold: true, name: 'Arial', size: 12, color: { argb: 'FF1E3A8A' } };
                titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
                titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
                ws.getRow(1).height = 32;

                // Cabeçalho
                ws.columns = [
                    { header: 'Data', key: 'data', width: 12 },
                    { header: 'Dia da Semana', key: 'diaSem', width: 16 },
                    { header: 'Tipo', key: 'tipo', width: 32 },
                    { header: 'Horas', key: 'horas', width: 10 },
                    { header: 'Programa', key: 'obs', width: 24 },
                ];
                ws.getRow(2).eachCell(cell => applyStyle(cell, headerStyle()));
                ws.getRow(2).height = 24;

                // Dados
                c.detalhes.forEach((d, i) => {
                    const row = ws.addRow({ data: d.data, diaSem: d.diaSemana, tipo: d.tipo, horas: d.horas, obs: d.obs || '—' });
                    row.height = 18;
                    row.eachCell(cell => applyStyle(cell, cellStyle(i + 3)));
                    row.getCell('horas').numFmt = '0"h"';
                });

                // Total
                const lastDataRow = c.detalhes.length + 2;
                const totalRow = ws.addRow({ data: '', diaSem: '', tipo: 'TOTAL', horas: `=SOMA(D3:D${lastDataRow})`, obs: '' });
                totalRow.height = 22;
                totalRow.eachCell(cell => {
                    applyStyle(cell, cellStyle(0));
                    cell.font = { bold: true, name: 'Arial', size: 10 };
                });
                totalRow.getCell('horas').numFmt = '0"h"';
            }
        }

        const periodo = `${inicio(req)}_${fim(req)}`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="horas_extras_${periodo}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error('[ExportController] exportHorasExtras:', err.message);
        if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
    }
};

// Helper para pegar query params formatados
function inicio(req) { return (req.query.inicio || '').replace(/-/g, ''); }
function fim(req) { return (req.query.fim || '').replace(/-/g, ''); }

module.exports = { exportEscala, exportHorasExtras };