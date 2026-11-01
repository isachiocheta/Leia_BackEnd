'use strict';

const express = require('express');
const { body, query } = require('express-validator');
const { exigirAutenticacao, exigirPerfil } = require('../autenticacao/rotas');
const { protegerCsrf } = require('../autenticacao/csrf');
const { responderDetalhe, responderLista, responderSemConteudo } = require('../utilitarios/respostas');
const {
  validarIdPositivo, validarRequisicao, rejeitarCamposDesconhecidos, rejeitarPatchVazio, selecionarCamposPermitidos,
} = require('../validacao/requisicao');
const servico = require('../servicos/catalogo');

function capaHttps(valor) {
  if (valor === null) return true;
  if (typeof valor !== 'string' || !/^https:\/\//i.test(valor) || /[\u0000-\u0020\u007f]/.test(valor)) return false;
  try {
    const endereco = new URL(valor);
    return endereco.protocol === 'https:' && Boolean(endereco.hostname) && !endereco.username && !endereco.password;
  } catch { return false; }
}

function regrasLivro(parcial = false) {
  const obrigatorios = [
    body('titulo').isString().bail().trim().isLength({ min: 1, max: 160 }),
    body('autor').isString().bail().trim().isLength({ min: 1, max: 120 }),
    validarIdPositivo('generoId', 'body'),
    body('totalPaginas').custom((valor) => Number.isInteger(valor) && valor > 0 && valor <= 2147483647),
  ];
  if (parcial) obrigatorios.forEach((regra) => regra.optional());
  return [
    ...obrigatorios,
    // Null explícito limpa o campo; ausência não participa do matchedData/PATCH.
    body('anoPublicacao').optional().custom((valor) => valor === null || (Number.isInteger(valor) && valor >= 1 && valor <= servico.anoAtual())),
    body('descricao').optional().custom((valor) => valor === null || (typeof valor === 'string' && Array.from(valor).length <= 2000)),
    body('capaUrl').optional().custom(capaHttps),
  ];
}

function protegerConsulta(roteador) {
  roteador.use(exigirAutenticacao, exigirPerfil('ADMIN_CLUBE', 'LEITOR'));
}

function criarRotasGeneros({ obterConexao }) {
  const roteador = express.Router();
  protegerConsulta(roteador);
  roteador.get('/', rejeitarCamposDesconhecidos(['page', 'pageSize'], { local: 'query' }), async (requisicao, resposta) => {
    const resultado = await servico.listarGeneros(requisicao.query, obterConexao());
    responderLista(resposta, resultado.data, resultado.meta);
  });
  return roteador;
}

function criarRotasLivros({ obterConexao }) {
  const roteador = express.Router();
  protegerConsulta(roteador);
  const escrita = [exigirPerfil('ADMIN_CLUBE'), protegerCsrf];
  roteador.get('/',
    rejeitarCamposDesconhecidos(['q', 'generoId', 'sort', 'direction', 'page', 'pageSize'], { local: 'query' }),
    query('q').optional().isString().bail().trim().isLength({ min: 1, max: 160 }),
    validarIdPositivo('generoId', 'query').optional(),
    query('sort').optional().isIn(['titulo', 'anoPublicacao']),
    validarRequisicao,
    async (requisicao, resposta) => {
      // Query é somente leitura no Express 5. Usa o valor sanitizado dos filtros
      // e mantém os parâmetros de paginação para o helper estrito compartilhado.
      const filtros = selecionarCamposPermitidos(requisicao, ['q', 'generoId'], { local: 'query' });
      const { q, generoId, ...paginacao } = requisicao.query;
      const resultado = await servico.listarLivros({ ...paginacao, ...filtros }, obterConexao());
      responderLista(resposta, resultado.data, resultado.meta);
    });
  roteador.get('/:id', validarIdPositivo(), validarRequisicao, async (requisicao, resposta) => {
    const { id } = selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' });
    responderDetalhe(resposta, await servico.consultarLivro(id, obterConexao()));
  });
  roteador.post('/', ...escrita,
    rejeitarCamposDesconhecidos(servico.CAMPOS_LIVRO), ...regrasLivro(), validarRequisicao,
    async (requisicao, resposta) => {
      const dados = selecionarCamposPermitidos(requisicao, servico.CAMPOS_LIVRO);
      responderDetalhe(resposta, await servico.criarLivro(dados, obterConexao()), 201);
    });
  roteador.patch('/:id', ...escrita,
    validarIdPositivo(), rejeitarCamposDesconhecidos(servico.CAMPOS_LIVRO), rejeitarPatchVazio(servico.CAMPOS_LIVRO),
    ...regrasLivro(true), validarRequisicao,
    async (requisicao, resposta) => {
      const { id } = selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' });
      const dados = selecionarCamposPermitidos(requisicao, servico.CAMPOS_LIVRO);
      responderDetalhe(resposta, await servico.editarLivro(id, dados, obterConexao()));
    });
  roteador.delete('/:id', ...escrita, validarIdPositivo(), validarRequisicao, async (requisicao, resposta) => {
    const { id } = selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' });
    await servico.excluirLivro(id, obterConexao());
    responderSemConteudo(resposta);
  });
  return roteador;
}

module.exports = { criarRotasGeneros, criarRotasLivros };
