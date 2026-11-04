'use strict';

const { dataCivilReal, FUSO_CLUBE } = require('../../utilitarios/datas-civis');
const { configuracaoInvalida } = require('../../configuracao/demonstracao');

function calendario(data, dias = 0) {
  const [ano, mes, dia] = data.split('-').map(Number);
  const instante = new Date(0); instante.setUTCFullYear(ano, mes - 1, dia); instante.setUTCHours(0, 0, 0, 0);
  instante.setUTCDate(instante.getUTCDate() + dias);
  const resultado = instante.toISOString().slice(0, 10);
  if (!dataCivilReal(resultado)) throw configuracaoInvalida();
  // UTC é usado apenas para aritmética do calendário, nunca como meia-noite local.
  return resultado;
}

const formatador = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_CLUBE,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function asDezoito(data) {
  const esperado = Date.parse(`${data}T18:00:00Z`); let valor = esperado;
  for (let tentativa = 0; tentativa < 4; tentativa += 1) {
    const p = Object.fromEntries(formatador.formatToParts(new Date(valor)).map(({ type, value }) => [type, value]));
    const observado = Date.parse(`${p.year.padStart(4, '0')}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    const diferenca = esperado - observado;
    if (diferenca === 0) return new Date(valor);
    valor += diferenca;
  }
  // Usa as regras IANA, inclusive horário de verão histórico; não fixa -03:00.
  throw configuracaoInvalida();
}

function criarPlano(dataBase) {
  const dia = (deslocamento) => calendario(dataBase, deslocamento);
  const usuarios = {
    inicio: { nome: 'Leitor Demo Início', email: 'demo.inicio@leia.example', situacao: 'ATIVO' },
    metade: { nome: 'Leitor Demo Metade', email: 'demo.metade@leia.example', situacao: 'ATIVO' },
    final: { nome: 'Leitor Demo Final', email: 'demo.final@leia.example', situacao: 'ATIVO' },
    semParticipacao: { nome: 'Leitor Demo Sem Adesão', email: 'demo.sem.adesao@leia.example', situacao: 'ATIVO' },
    pendente: { nome: 'Leitor Demo Pendente', email: 'demo.pendente@leia.example', situacao: 'PENDENTE' },
  };
  return {
    usuarios,
    livros: {
      principal: { titulo: '[Demo Leia+] O jardim das perguntas', autor: 'Autoria de demonstração', totalPaginas: 300, genero: 'Romance' },
      futuro: { titulo: '[Demo Leia+] Caminhos da escola', autor: 'Autoria de demonstração', totalPaginas: 200, genero: 'Aventura' },
    },
    ciclos: {
      concluido: { nome: '[Demo Leia+] Leitura anterior', livro: 'principal', dataInicio: dia(-45), dataFim: dia(-15), situacao: 'CONCLUIDO' },
      atual: { nome: '[Demo Leia+] Leitura atual', livro: 'principal', dataInicio: dia(-7), dataFim: dia(14), situacao: 'EM_ANDAMENTO' },
      planejado: { nome: '[Demo Leia+] Próxima leitura', livro: 'futuro', dataInicio: dia(21), dataFim: dia(42), situacao: 'PLANEJADO' },
    },
    encontros: {
      anterior: { ciclo: 'concluido', titulo: '[Demo Leia+] Conversa anterior', inicioEm: asDezoito(dia(-20)), situacao: 'REALIZADO' },
      realizado: { ciclo: 'atual', titulo: '[Demo Leia+] Conversa realizada', inicioEm: asDezoito(dia(-2)), situacao: 'REALIZADO' },
      proximo: { ciclo: 'atual', titulo: '[Demo Leia+] Próxima conversa', inicioEm: asDezoito(dia(2)), situacao: 'AGENDADO' },
      seguinte: { ciclo: 'atual', titulo: '[Demo Leia+] Conversa seguinte', inicioEm: asDezoito(dia(7)), situacao: 'AGENDADO' },
      cancelado: { ciclo: 'atual', titulo: '[Demo Leia+] Conversa cancelada', inicioEm: asDezoito(dia(3)), situacao: 'CANCELADO' },
      planejado: { ciclo: 'planejado', titulo: '[Demo Leia+] Abertura futura', inicioEm: asDezoito(dia(25)), situacao: 'AGENDADO' },
    },
    participacoes: {
      inicio: { usuario: 'inicio', ciclo: 'atual', paginaAtual: 0, concluidaEm: null },
      metade: { usuario: 'metade', ciclo: 'atual', paginaAtual: 150, concluidaEm: null },
      final: { usuario: 'final', ciclo: 'atual', paginaAtual: 300, concluidaEm: asDezoito(dia(-1)) },
      historica: { usuario: 'final', ciclo: 'concluido', paginaAtual: 300, concluidaEm: asDezoito(dia(-16)) },
    },
    inscricoes: {
      inicio: { usuario: 'inicio', encontro: 'proximo' }, metade: { usuario: 'metade', encontro: 'proximo' },
      final: { usuario: 'final', encontro: 'seguinte' }, historica: { usuario: 'final', encontro: 'anterior' },
      realizada: { usuario: 'metade', encontro: 'realizado' }, cancelada: { usuario: 'inicio', encontro: 'cancelado' },
    },
  };
}

module.exports = { criarPlano, calendario, asDezoito };
