'use strict';

const FUSO_CLUBE = 'America/Sao_Paulo';
const formatador = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO_CLUBE, year: 'numeric', month: '2-digit', day: '2-digit',
});

function dataCivilReal(valor) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const [ano, mes, dia] = valor.split('-').map(Number);
  if (ano < 1 || mes < 1 || mes > 12 || dia < 1) return false;
  const bissexto = ano % 4 === 0 && (ano % 100 !== 0 || ano % 400 === 0);
  const diasPorMes = [31, bissexto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return dia <= diasPorMes[mes - 1];
}

function dataEmSaoPaulo(instante = Date.now()) {
  // Converte apenas instantes. Datas civis de entrada continuam strings DATEONLY.
  const partes = Object.fromEntries(formatador.formatToParts(new Date(instante)).map(({ type, value }) => [type, value]));
  return `${partes.year.padStart(4, '0')}-${partes.month}-${partes.day}`;
}

module.exports = { FUSO_CLUBE, dataCivilReal, dataEmSaoPaulo };
