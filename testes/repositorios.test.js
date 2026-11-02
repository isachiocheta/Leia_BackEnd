'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { carregarConsulta } = require('../database/consultas/carregar');
const participacoes = require('../repositorios/participacoes');
const { livrosMinimoCiclos } = require('../repositorios/relatorios');
const { listarParticipantes, listarMinhasParticipacoes } = require('../servicos/participacoes');
const { demonstrarEscritasEmTeste } = require('../repositorios/exemplos');

test('carregador usa somente arquivos cadastrados e rejeita caminhos arbitrários', () => {
  assert.equal(carregarConsulta('participantesCiclo'), readFileSync(join(__dirname, '../database/consultas/participantes-ciclo.sql'), 'utf8'));
  for (const nome of ['../../.env', 'constructor', '__proto__', '/etc/passwd']) assert.throws(() => carregarConsulta(nome), TypeError);
});

test('repositório executa o arquivo da aplicação com binds e a mesma transação', async () => {
  const chamadas = []; const transaction = {};
  const conexao = { async query(sql, opcoes) { chamadas.push({ sql, opcoes }); return /SELECT count\(\*\) AS total/i.test(sql) ? [{ total: '0' }] : []; } };
  await participacoes.participantesCiclo(7, conexao, { transaction, limit: 2, offset: 3 });
  assert.equal(chamadas[0].sql, carregarConsulta('participantesCiclo'));
  assert.deepEqual(chamadas[0].opcoes.bind, { ciclo: 7, limite: 2, deslocamento: 3 });
  assert.equal(chamadas[0].opcoes.transaction, transaction);
  await assert.rejects(livrosMinimoCiclos("1; DELETE FROM livros", conexao), TypeError);
  await assert.rejects(participacoes.historicoLeituras(7, conexao, { limit: 51 }), TypeError);
  assert.equal(chamadas.length, 2);
});

test('adaptadores preservam os campos HTTP antigos apesar do enriquecimento dos relatórios', async () => {
  const registro = { id: 1, cicloId: 7, paginaAtual: 0, percentual: 0, concluida: false, concluidaEm: null, usuario: { id: 5, nome: 'Leitor' }, livro: { id: 3 }, genero: { id: 2 } };
  const conexao = {
    models: { CicloLeitura: { async findByPk() { return { id: 7 }; } } },
    async query(sql) {
      if (/SELECT count\(\*\) AS total/i.test(sql)) return [{ total: '1' }];
      if (sql === carregarConsulta('participantesCiclo')) { const { genero, ...dados } = registro; return [dados]; }
      return [registro];
    },
  };
  const lista = await listarParticipantes(7, {}, conexao); assert.equal(lista.data[0].livro, undefined); assert.deepEqual(lista.data[0].usuario, registro.usuario);
  const historico = await listarMinhasParticipacoes(5, {}, conexao); assert.equal(historico.data[0].genero, undefined); assert.deepEqual(historico.data[0].livro, registro.livro);
});

test('demonstração de escrita recusa ambiente normal antes de abrir transação', async () => {
  const anterior = process.env.NODE_ENV; process.env.NODE_ENV = 'production'; let abriu = false;
  try { await assert.rejects(demonstrarEscritasEmTeste({ async transaction() { abriu = true; } }, { nome: 'Exemplo', novoNome: 'Alterado' }), /NODE_ENV/); }
  finally { if (anterior === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = anterior; }
  assert.equal(abriu, false);
});
